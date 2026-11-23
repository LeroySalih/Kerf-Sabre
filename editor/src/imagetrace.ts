// Image trace: a picture pasted into the editor becomes paths. The picture is flattened to black and white (threshold), Potrace (WASM, run in the
// browser: the picture is never sent anywhere) finds the outlines as cubic Beziers, and they are scaled to mm and flipped to bed space (Y up).
// Everything but `traceImage`'s Potrace call is pure and tested (tests/imagetrace.test.ts).
import type { Point } from "./coords";
import { boundsOf, type Path, type Seg } from "./geometry";

export interface TraceOptions {
  /** 0-255: a pixel darker than this is "black" (traced). */
  threshold: number;
  /** Trace the light parts instead (a light drawing on a dark background). */
  invert: boolean;
  /** Potrace's despeckle: blobs smaller than this many pixels are ignored. */
  specks: number;
  /** Corner handling: 0 sharp polygon corners, up to 1.34 fully smooth curves. */
  smoothing: number;
  /** Width of the finished tracing in mm (the height follows the picture's shape). */
  widthMm: number;
  /** Shapes narrower than this in both directions (mm) are dropped: the laser could not cut them. */
  minFeatureMm: number;
}

export const DEFAULT_TRACE: TraceOptions = { threshold: 128, invert: false, specks: 8, smoothing: 1, widthMm: 100, minFeatureMm: 1 };
/** The picture is shrunk to this many pixels on its longest side before tracing: a bigger one only makes a heavier, noisier result. */
export const MAX_TRACE_PX = 1200;

export interface Bitmap { width: number; height: number; data: Uint8ClampedArray } // RGBA, like ImageData

/** Luma (0-255) of a pixel, with transparent pixels counted as white paper. */
export function luma(r: number, g: number, b: number, a: number): number {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const k = a / 255;
  return l * k + 255 * (1 - k);
}

/** The picture as pure black (traced) on pure white (ignored), same size. */
export function toBlackWhite(img: Bitmap, threshold: number, invert: boolean): Bitmap {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const dark = luma(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!) < threshold;
    const v = dark !== invert ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** The size to draw a picture at so its longest side is at most `max` pixels (never bigger than it is). */
export function fitPixels(w: number, h: number, max = MAX_TRACE_PX): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The share of pixels that would be traced, 0 to 1 (a tracing of nearly everything or nothing means the threshold or Invert is wrong). */
export function blackShare(bw: Bitmap): number {
  let n = 0;
  for (let i = 0; i < bw.data.length; i += 4) if (bw.data[i] === 0) n++;
  return n / (bw.data.length / 4);
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** SVG path data (M L C H V Z, upper or lower case) as paths in the same units. Anything else (arcs, quadratics) is ignored. */
export function parsePathData(d: string): Path[] {
  const out: Path[] = [];
  let cur: Path | null = null;
  let pos: Point = { x: 0, y: 0 }, start: Point = { x: 0, y: 0 };
  const finish = (closed: boolean) => {
    if (cur && cur.segs.length) { cur.closed = closed; out.push(cur); }
    cur = null;
  };
  const re = /([MmLlHhVvCcZz])([^MmLlHhVvCcZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const cmd = m[1]!;
    const rel = cmd === cmd.toLowerCase();
    const nums = (m[2]!.match(NUM) ?? []).map(Number);
    const abs = (x: number, y: number): Point => (rel ? { x: pos.x + x, y: pos.y + y } : { x, y });
    switch (cmd.toUpperCase()) {
      case "M":
        finish(false);
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const p = abs(nums[i]!, nums[i + 1]!);
          if (i === 0) { pos = start = p; cur = { start: p, segs: [], closed: false }; }
          else { cur!.segs.push({ t: "l", to: p }); pos = p; } // extra pairs after M are lineto
        }
        break;
      case "L":
        for (let i = 0; i + 1 < nums.length; i += 2) { const p = abs(nums[i]!, nums[i + 1]!); cur?.segs.push({ t: "l", to: p }); pos = p; }
        break;
      case "H":
        for (const x of nums) { const p = { x: rel ? pos.x + x : x, y: pos.y }; cur?.segs.push({ t: "l", to: p }); pos = p; }
        break;
      case "V":
        for (const y of nums) { const p = { x: pos.x, y: rel ? pos.y + y : y }; cur?.segs.push({ t: "l", to: p }); pos = p; }
        break;
      case "C":
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const c1 = abs(nums[i]!, nums[i + 1]!), c2 = abs(nums[i + 2]!, nums[i + 3]!), to = abs(nums[i + 4]!, nums[i + 5]!);
          cur?.segs.push({ t: "c", c1, c2, to });
          pos = to;
        }
        break;
      case "Z":
        finish(true);
        pos = start;
        break;
    }
  }
  finish(false);
  return out;
}

const mapSeg = (s: Seg, f: (p: Point) => Point): Seg =>
  s.t === "c" ? { t: "c", c1: f(s.c1), c2: f(s.c2), to: f(s.to) } : s.t === "l" ? { t: "l", to: f(s.to) } : { ...s, c: f(s.c), to: f(s.to) };

/** Potrace writes its paths in tenths of a pixel with Y already pointing up, from the picture's bottom-left corner: exactly bed space. */
export const POTRACE_UNITS_PER_PX = 10;

/** Scale traced paths by `k` (mm per unit of the path data). The picture's bottom-left corner stays the origin (0,0). */
export function toDesign(paths: Path[], k: number): Path[] {
  const f = (p: Point): Point => ({ x: p.x * k, y: p.y * k });
  return paths.map((p) => ({ start: f(p.start), segs: p.segs.map((s) => mapSeg(s, f)), closed: p.closed }));
}

/** Drop shapes too small to cut: both sides under `minMm`. */
export function dropSmall(paths: Path[], minMm: number): Path[] {
  return paths.filter((p) => {
    const b = boundsOf(p);
    return b.maxX - b.minX >= minMm || b.maxY - b.minY >= minMm;
  });
}

/** Everything about the result the dialog tells the pupil. */
export interface TraceResult { paths: Path[]; widthMm: number; heightMm: number; share: number; dropped: number }

/** Potrace's own options for ours. */
export const potraceOptions = (o: TraceOptions) => ({
  turdsize: Math.max(0, Math.round(o.specks)), turnpolicy: 4, alphamax: Math.min(1.34, Math.max(0, o.smoothing)),
  opticurve: 1, opttolerance: 0.4, pathonly: true as const, extractcolors: false,
});

let ready: Promise<typeof import("esm-potrace-wasm")> | null = null;
/** Load Potrace the first time it is needed (it is a separate chunk, so the Editor starts without it). */
function loadPotrace() {
  ready ??= import("esm-potrace-wasm").then(async (m) => { await m.init(); return m; });
  return ready;
}

/** Trace a picture already drawn at its tracing size (`img`, RGBA). Browser only (Potrace needs ImageData / canvas). */
export async function traceImage(img: Bitmap, o: TraceOptions): Promise<TraceResult> {
  const bw = toBlackWhite(img, o.threshold, o.invert);
  const share = blackShare(bw);
  if (share === 0) return { paths: [], widthMm: 0, heightMm: 0, share, dropped: 0 };
  const potrace = await loadPotrace();
  const data = new ImageData(new Uint8ClampedArray(bw.data), bw.width, bw.height);
  const raw = (await potrace.potrace(data, potraceOptions(o))) as string[];
  const mmPerPx = o.widthMm / bw.width;
  const all = toDesign(raw.flatMap(parsePathData), mmPerPx / POTRACE_UNITS_PER_PX);
  const paths = dropSmall(all, o.minFeatureMm);
  return { paths, widthMm: o.widthMm, heightMm: bw.height * mmPerPx, share, dropped: all.length - paths.length };
}
