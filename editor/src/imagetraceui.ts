// The "Trace image" window: a pasted, dropped or chosen picture is shown as a live dashed tracing on the bed while the pupil adjusts it.
import { openDialog, type DialogValue } from "./dialog";
import { DEFAULT_TRACE, fitPixels, type Bitmap, type TraceOptions, type TraceResult, traceImage } from "./imagetrace";
import type { LayerType } from "./doc";

/** A picture file as pixels, shrunk for tracing, transparent parts flattened onto white. Throws if the browser cannot read it. */
export async function bitmapFromBlob(blob: Blob): Promise<Bitmap> {
  const img = await createImageBitmap(blob);
  const { width, height } = fitPixels(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(img, 0, 0, width, height);
  img.close();
  const d = g.getImageData(0, 0, width, height);
  return { width, height, data: d.data };
}

export interface TraceAnswer { result: TraceResult; layer: LayerType }

const num = (v: DialogValue | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The settings the dialog starts with: as wide as 60% of the bed (at most 200 mm), never taller than the bed either. */
export function startWidth(src: Bitmap, bedW: number, bedH: number): number {
  const w = Math.min(200, bedW * 0.6, (bedH * 0.6 * src.width) / src.height);
  return Math.max(10, Math.round(w / 5) * 5 || 10);
}

/**
 * Ask how to trace `src`. `show` draws (or, with null, clears) the live tracing; it is given the traced paths in design space.
 * Resolves with the final tracing, or null when cancelled.
 */
export async function askTrace(src: Bitmap, bed: { widthMm: number; heightMm: number }, show: (paths: TraceResult | null) => void): Promise<TraceAnswer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run = 0;
  const cache = new Map<string, TraceResult>();
  const opts = (v: Record<string, DialogValue>): TraceOptions => ({
    threshold: num(v.threshold, DEFAULT_TRACE.threshold), invert: v.invert === "yes", specks: num(v.specks, DEFAULT_TRACE.specks),
    smoothing: num(v.smoothing, DEFAULT_TRACE.smoothing), widthMm: num(v.widthMm, 100), minFeatureMm: num(v.minFeatureMm, DEFAULT_TRACE.minFeatureMm),
  });
  const trace = async (o: TraceOptions): Promise<TraceResult> => {
    const key = JSON.stringify(o);
    return cache.get(key) ?? (cache.set(key, await traceImage(src, o)), cache.get(key)!);
  };
  const w0 = startWidth(src, bed.widthMm, bed.heightMm);
  const v = await openDialog("Trace image", [
    { key: "threshold", label: "Threshold (0 to 255)", type: "number", value: DEFAULT_TRACE.threshold, min: 1, max: 254, integer: true, hint: "Pixels darker than this are traced. Raise it to trace more, lower it to trace less." },
    { key: "invert", label: "Trace", type: "select", value: "no", options: [{ value: "no", label: "The dark parts" }, { value: "yes", label: "The light parts" }] },
    { key: "widthMm", label: "Width (mm)", type: "number", value: w0, min: 5, max: 2000, hint: "The height follows the picture's shape." },
    { key: "specks", label: "Ignore specks smaller than (pixels)", type: "number", value: DEFAULT_TRACE.specks, min: 0, max: 1000, integer: true },
    { key: "smoothing", label: "Corners", type: "select", value: "1", options: [{ value: "0", label: "Sharp" }, { value: "1", label: "Normal" }, { value: "1.34", label: "Smooth" }] },
    { key: "minFeatureMm", label: "Drop shapes smaller than (mm)", type: "number", value: DEFAULT_TRACE.minFeatureMm, min: 0, max: 50, hint: "The laser cannot cut detail this small." },
    { key: "layer", label: "Put the lines on", type: "select", value: "cut", options: [{ value: "cut", label: "Cut" }, { value: "score", label: "Score" }] },
  ], {
    intro: "Turns the picture's dark shapes into outlines you can cut or score. A drawing or logo with strong black and white works best; a photo will not. The tracing is previewed dashed on the bed: drag this window by its title to see it.",
    ok: "Trace",
    onChange: (vals) => {
      clearTimeout(timer);
      if (!vals) { run++; show(null); return; }
      const o = opts(vals);
      if (!(o.widthMm >= 5)) return "⚠ Give a width of at least 5 mm.";
      const me = ++run;
      timer = setTimeout(() => { void trace(o).then((r) => { if (me === run) show(r); }, () => { if (me === run) show(null); }); }, 150);
      return `The tracing will be ${Math.round(o.widthMm)} × ${Math.round((o.widthMm * src.height) / src.width)} mm.`;
    },
  });
  clearTimeout(timer);
  run++;
  show(null);
  if (!v) return null;
  return { result: await trace(opts(v)), layer: v.layer === "score" ? "score" : "cut" };
}
