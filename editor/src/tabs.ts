// Tabs (bridges): short stretches of a closed Cut outline that are left uncut so the part stays attached.
// A tab is stored as a fraction along the outline's length, and a width in mm, so it survives moving and scaling.
// Pure; bed space (mm).
import type { Point } from "./coords";
import { arcSweep, flatten, type Path, type Seg } from "./geometry";
import { explicit, extract } from "./trim";

export interface TabSpec {
  widthMm: number;
  /** Tab centres as fractions (0 to 1) of the outline's length. */
  at: number[];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const CURVE_SAMPLES = 64;

function cubicPoint(a: Point, s: Extract<Seg, { t: "c" }>, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
    y: u * u * u * a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
  };
}

/** Cumulative arc length at CURVE_SAMPLES+1 sample parameters of a cubic. */
function cubicTable(a: Point, s: Extract<Seg, { t: "c" }>): number[] {
  const out = [0];
  let prev = a;
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const p = cubicPoint(a, s, i / CURVE_SAMPLES);
    out.push(out[i - 1]! + dist(prev, p));
    prev = p;
  }
  return out;
}

const startsOf = (p: Path): Point[] => p.segs.map((_, i) => (i === 0 ? p.start : p.segs[i - 1]!.to));

/** Length of each segment of the (explicitly closed) path. */
export function segLengths(path: Path): number[] {
  const q = explicit(path);
  const st = startsOf(q);
  return q.segs.map((s, i) => {
    if (s.t === "l") return dist(st[i]!, s.to);
    if (s.t === "a") return dist(st[i]!, s.c) * Math.abs(arcSweep(s.c, st[i]!, s.to, s.ccw));
    return cubicTable(st[i]!, s)[CURVE_SAMPLES]!;
  });
}

export const pathLength = (path: Path): number => segLengths(path).reduce((a, b) => a + b, 0);

/** Position along a path (segment index + fraction of that segment's parameter) for an arc length `s`. */
export function lengthToU(path: Path, s: number): number {
  const q = explicit(path);
  const lens = segLengths(q);
  const total = lens.reduce((a, b) => a + b, 0);
  const n = lens.length;
  if (q.closed && s > total) return n + lengthToU(q, s - total);
  if (q.closed && s < 0) return lengthToU(q, s + total) - n;
  const st = startsOf(q);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (s <= acc + lens[i]! || i === n - 1) {
      const l = Math.min(Math.max(s - acc, 0), lens[i]!);
      const seg = q.segs[i]!;
      if (seg.t !== "c") return i + (lens[i]! > 0 ? l / lens[i]! : 0);
      const table = cubicTable(st[i]!, seg);
      let j = 1;
      while (j < CURVE_SAMPLES && table[j]! < l) j++;
      const span = table[j]! - table[j - 1]!;
      return i + (j - 1 + (span > 0 ? (l - table[j - 1]!) / span : 0)) / CURVE_SAMPLES;
    }
    acc += lens[i]!;
  }
  return n;
}

/** Evenly spaced tab centres, starting half a step in so none sits on the seam. */
export const autoTabFractions = (count: number): number[] => Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => (i + 0.5) / count);

/** Tab intervals as [start, end] arc lengths, merged where they overlap, and clamped so the outline keeps some cut. */
export function tabIntervals(path: Path, spec: TabSpec): [number, number][] {
  const total = pathLength(path);
  if (!(total > 0) || !spec.at.length || !(spec.widthMm > 0)) return [];
  const half = Math.min(spec.widthMm, (total * 0.9) / spec.at.length) / 2; // never swallow the whole outline
  const ivs = spec.at.map((f): [number, number] => [((f % 1) + 1) % 1 * total - half, ((f % 1) + 1) % 1 * total + half]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // an interval hanging over the seam may overlap the first one once shifted by a full turn
  if (merged.length > 1) {
    const first = merged[0]!, last = merged[merged.length - 1]!;
    if (last[1] - total >= first[0]) { first[0] = Math.min(first[0], last[0] - total); first[1] = Math.max(first[1], last[1] - total); merged.pop(); }
  }
  return merged;
}

/**
 * The path with its tabs removed, as separate open pieces (what the laser actually cuts). Open paths and paths without
 * tabs come back whole.
 */
export function splitByTabs(path: Path, spec: TabSpec | undefined): Path[] {
  if (!spec || !path.closed) return [path];
  const q = explicit(path);
  const total = pathLength(q);
  const ivs = tabIntervals(q, spec);
  if (!ivs.length) return [path];
  const out: Path[] = [];
  for (let i = 0; i < ivs.length; i++) {
    const from = ivs[i]![1];
    const to = i + 1 < ivs.length ? ivs[i + 1]![0] : ivs[0]![0] + total; // wraps past the seam for the last piece
    if (to - from <= 1e-6) continue;
    const piece = extract(q, lengthToU(q, from), lengthToU(q, to));
    if (piece) out.push(piece);
  }
  return out;
}

/** The tab intervals themselves, as short paths (for drawing the gaps). */
export function tabPieces(path: Path, spec: TabSpec | undefined): Path[] {
  if (!spec || !path.closed) return [];
  const q = explicit(path);
  const total = pathLength(q);
  return tabIntervals(q, spec).map(([a, b]) => extract(q, lengthToU(q, a < 0 ? a + total : a), lengthToU(q, (a < 0 ? a + total : a) + (b - a)))).filter((p): p is Path => p !== null);
}

/** How far along the outline (0 to 1) the point nearest `p` is, if it is within `tolMm` of it. */
export function nearestFraction(path: Path, p: Point, tolMm: number): number | null {
  const q = explicit(path);
  const lens = segLengths(q);
  const total = lens.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const st = startsOf(q);
  let best: { s: number; d: number } | null = null;
  let acc = 0;
  q.segs.forEach((seg, i) => {
    const pts = flatten({ start: st[i]!, segs: [seg], closed: false }, 0.01);
    const chords = pts.slice(1).map((b, k) => dist(pts[k]!, b));
    const polyLen = chords.reduce((a, b) => a + b, 0) || 1;
    let run = 0;
    for (let k = 0; k < chords.length; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 < 1e-18 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const d = dist(p, { x: a.x + dx * t, y: a.y + dy * t });
      if (d <= tolMm && (!best || d < best.d)) best = { s: acc + ((run + chords[k]! * t) / polyLen) * lens[i]!, d };
      run += chords[k]!;
    }
    acc += lens[i]!;
  });
  return best ? (best as { s: number }).s / total : null;
}

/** Add a tab at fraction `f`, or remove the existing one if `f` is within a tab-width of it. */
export function toggleTab(spec: TabSpec | undefined, f: number, widthMm: number, path: Path): TabSpec {
  const total = pathLength(path);
  const cur: TabSpec = spec ?? { widthMm, at: [] };
  const near = cur.at.findIndex((x) => { const d = Math.abs(x - f); return Math.min(d, 1 - d) * total <= Math.max(cur.widthMm, widthMm) / 2; });
  if (near >= 0) return { widthMm: cur.widthMm, at: cur.at.filter((_, i) => i !== near) };
  return { widthMm: cur.at.length ? cur.widthMm : widthMm, at: [...cur.at, f] };
}
