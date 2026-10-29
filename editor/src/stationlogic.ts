// Station mode: the small pure pieces (what can be pressed now, what to say, the outline preview).
import { flatten, transformPath } from "./geometry";
import type { JobObject } from "./job";
import { fromJobObjects } from "./job";
import type { Extent, QueueEntry, StationInfo } from "./server";

export interface StepState {
  /** What the pupil should do next, in a sentence. */
  say: string;
  canFrame: boolean;
  canStart: boolean;
  framed: boolean;
}

/**
 * `entry` is the job that is next for this laser. Frame needs a connected, idle laser. Start also needs the outline
 * checked (framed on this laser) and the material confirmed.
 */
export function stepState(entry: QueueEntry | undefined, station: StationInfo | undefined, stationId: string, materialConfirmed: boolean): StepState {
  const none = { canFrame: false, canStart: false, framed: false };
  if (!station || !station.online) return { ...none, say: "The Cutter on this laser PC is not connected. Ask a teacher." };
  if (station.currentJobId) return { ...none, say: "Cutting in progress." };
  if (!entry) return { ...none, say: "Nothing is waiting for this laser." };
  const idle = station.state === "Idle" || !station.state;
  const framed = entry.framedOn === stationId;
  if (!idle) return { ...none, framed, say: `The laser is busy (${station.state}). Wait a moment.` };
  if (!framed) return { canFrame: true, canStart: false, framed, say: "Put your material on the bed, then press Frame to see where it will cut." };
  if (!materialConfirmed) return { canFrame: true, canStart: false, framed, say: "Check the outline sits on your material, then tick that the right material is loaded." };
  return { canFrame: true, canStart: true, framed, say: "Ready. Stand clear of the laser and press Start." };
}

/**
 * How far a cut has got, 0 to 99 while it runs. By time against the estimate when both are known: the laser's lines are sent far ahead of the
 * cutting (GRBL queues a short job in a second), so the line count says "nearly done" almost at once. Without an estimate it falls back to lines.
 */
export const progressPct = (p: StationInfo["progress"]): number => {
  if (!p) return 0;
  const est = p.estimatedS ?? 0;
  if (est > 0 && typeof p.actualS === "number") return Math.max(0, Math.min(99, Math.round((100 * p.actualS) / est)));
  return p.totalLines > 0 ? Math.min(100, Math.round((100 * p.line) / p.totalLines)) : 0;
};

/**
 * What to say about the time left in a cut: "about 2:45 left", or a note once it has run past its estimate. Empty when there is no estimate or
 * no time yet. `fallbackEstimateS` is the queue entry's estimate, for when the progress message has none.
 */
export function remainingText(p: StationInfo["progress"], fallbackEstimateS = 0): string {
  const est = p?.estimatedS || fallbackEstimateS;
  if (!p || !(est > 0) || typeof p.actualS !== "number") return "";
  const left = est - p.actualS;
  return left > 0 ? `about ${formatClock(left)} left` : "taking a little longer than estimated";
}

export function formatClock(s: number): string {
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** An SVG of the job's outlines (Cut red, Score blue), true shape, Y up. Numbers only, so it is safe to inject. */
export function previewSvg(objects: JobObject[], size = 220): string {
  const shapes = fromJobObjects(objects).filter((sh) => sh.layer !== "ignore").map((sh) => ({ pts: flatten(transformPath(sh.path, sh.matrix), 0.2), layer: sh.layer, closed: sh.path.closed }));
  const all = shapes.flatMap((s) => s.pts);
  if (!all.length) return "";
  const minX = Math.min(...all.map((p) => p.x)), maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y)), maxY = Math.max(...all.map((p) => p.y));
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1), pad = Math.max(w, h) * 0.05;
  const r = (n: number) => Math.round(n * 100) / 100;
  const lines = shapes.map((s) => `<polyline fill="none" stroke="${s.layer === "cut" ? "#dc2626" : "#2563eb"}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${s.pts.map((p) => `${r(p.x - minX)},${r(maxY - p.y)}`).join(" ")}${s.closed ? ` ${r(s.pts[0]!.x - minX)},${r(maxY - s.pts[0]!.y)}` : ""}"/>`);
  const box = `<rect x="0" y="0" width="${r(w)}" height="${r(h)}" fill="none" stroke="#9ca3af" stroke-dasharray="4 3" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${r(-pad)} ${r(-pad)} ${r(w + 2 * pad)} ${r(h + 2 * pad)}" role="img" aria-label="Outline of the job, ${r(w)} by ${r(h)} millimetres">${box}${lines.join("")}</svg>`;
}

export const sizeOf = (objects: JobObject[]): { w: number; h: number } | null => {
  const pts = fromJobObjects(objects).filter((sh) => sh.layer !== "ignore").flatMap((sh) => flatten(transformPath(sh.path, sh.matrix), 0.2));
  if (!pts.length) return null;
  return { w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) };
};

/** "120 x 85 mm" for a design's size, or "" when the server has not measured it. */
export function sizeText(e: Extent | null | undefined): string {
  if (!e || !(e.widthMm >= 0) || !(e.heightMm >= 0)) return "";
  const r = (n: number) => String(Math.round(n * 10) / 10);
  return `${r(e.widthMm)} \u00d7 ${r(e.heightMm)} mm`;
}
