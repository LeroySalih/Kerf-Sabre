// Ruler ticks and the measure tool's numbers. Pure; drawing lives in main.ts.
import { screenToBed, type Point, type View } from "./coords";

export interface Tick { px: number; mm: number; major: boolean }

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const firstStep = (scale: number, minPx: number) => STEPS.find((s) => s * scale >= minPx) ?? STEPS[STEPS.length - 1]!;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Ticks for the top ruler (axis "x", px from the left) or the left ruler (axis "y", px from the top). */
export function rulerTicks(view: View, axis: "x" | "y", lengthPx: number): Tick[] {
  const a = axis === "x" ? screenToBed(view, { x: 0, y: 0 }).x : screenToBed(view, { x: 0, y: 0 }).y;
  const b = axis === "x" ? screenToBed(view, { x: lengthPx, y: 0 }).x : screenToBed(view, { x: 0, y: lengthPx }).y;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const minor = firstStep(view.scale, 8);
  const major = firstStep(view.scale, 50);
  const out: Tick[] = [];
  for (let k = Math.ceil(lo / minor - 1e-9); k * minor <= hi + 1e-9; k++) {
    const mm = round6(k * minor);
    const px = axis === "x" ? view.originPx.x + mm * view.scale : view.originPx.y - mm * view.scale;
    out.push({ px, mm, major: Math.abs(mm / major - Math.round(mm / major)) < 1e-6 });
  }
  return out;
}

export interface Measurement { distMm: number; dxMm: number; dyMm: number; angleDeg: number }

/** Distance, deltas and angle (degrees, counter-clockwise from +X, Y-up) from a to b. */
export function measure(a: Point, b: Point): Measurement {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { distMm: Math.hypot(dx, dy), dxMm: dx, dyMm: dy, angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI };
}

export function formatMeasurement(m: Measurement): string {
  const f = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
  return `${f(m.distMm)} mm  (dx ${f(m.dxMm)}, dy ${f(m.dyMm)})  ${f(m.angleDeg)}°`;
}
