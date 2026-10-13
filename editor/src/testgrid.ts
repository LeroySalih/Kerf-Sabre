// Material test generators. Pure: they return shapes in design space (mm, Y-up); the caller places them.
//  - Material test grid: a power x speed matrix of squares with scored labels. Each cell carries its own
//    power/speed so a run can burn the whole grid and the pupil picks the best cell.
//  - Kerf test: a coupon with slots of slightly different widths; the slot that grips a strip of the material
//    shows the kerf (kerf = material thickness - drawn slot width).
import type { LayerType, ShapeSettings } from "./doc";
import { boundsOf, rectangle, translation, transformPath, type Bounds, type Path } from "./geometry";
import { textToPaths } from "./text";

export interface TestItem {
  path: Path;
  layer: LayerType;
  settings?: ShapeSettings;
}

const LABEL_FONT = "hershey-futural"; // single-line: scores cleanly
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function label(text: string, sizeMm: number): Path[] {
  return textToPaths({ content: text, font: LABEL_FONT, sizeMm });
}

const union = (ps: Path[]): Bounds => {
  const bs = ps.map(boundsOf);
  return { minX: Math.min(...bs.map((b) => b.minX)), maxX: Math.max(...bs.map((b) => b.maxX)), minY: Math.min(...bs.map((b) => b.minY)), maxY: Math.max(...bs.map((b) => b.maxY)) };
};

/** Label paths moved so their box is centred on `cx` (anchor "centre") or ends at `cx` ("right"), baseline at `y`. */
function placeLabel(text: string, sizeMm: number, x: number, y: number, align: "centre" | "right"): Path[] {
  const ps = label(text, sizeMm);
  if (!ps.length) return [];
  const b = union(ps);
  const dx = align === "centre" ? x - (b.minX + b.maxX) / 2 : x - b.maxX;
  return ps.map((p) => transformPath(p, translation(dx, y)));
}

export interface TestGridParams {
  powerMin: number; powerMax: number; powerSteps: number; // one column per power
  speedMin: number; speedMax: number; speedSteps: number; // one row per speed (slowest at the bottom)
  cellMm: number;
  gapMm: number;
  labelMm: number;
  /** Cut: cells are cut-through squares. Score: scored squares (the surface-only variant). */
  mode: LayerType;
}

export function validateTestGrid(p: TestGridParams): string | null {
  const ints = [p.powerSteps, p.speedSteps];
  if (ints.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) return "Use 1 to 12 steps for power and for speed.";
  if (p.powerMin < 0 || p.powerMax > 100 || p.powerMin > p.powerMax) return "Power must be between 0 and 100, with the minimum not above the maximum.";
  if (!(p.speedMin > 0) || p.speedMin > p.speedMax) return "Speed must be above 0, with the minimum not above the maximum.";
  if (!(p.cellMm >= 2) || !(p.gapMm >= 0) || !(p.labelMm >= 1.5)) return "Cells need to be at least 2 mm, and labels at least 1.5 mm.";
  return null;
}

const steps = (min: number, max: number, n: number): number[] => Array.from({ length: n }, (_, i) => (n === 1 ? min : min + ((max - min) * i) / (n - 1)));

export function testGrid(p: TestGridParams): TestItem[] {
  const out: TestItem[] = [];
  const powers = steps(p.powerMin, p.powerMax, p.powerSteps).map((v) => Math.round(v * 100) / 100);
  const speeds = steps(p.speedMin, p.speedMax, p.speedSteps).map((v) => Math.round(v * 100) / 100);
  const pitch = p.cellMm + p.gapMm;
  speeds.forEach((speed, r) =>
    powers.forEach((power, c) => {
      out.push({ path: transformPath(rectangle(p.cellMm, p.cellMm), translation(c * pitch, r * pitch)), layer: p.mode, settings: { powerPct: power, speedMmPerS: speed } });
    }),
  );
  const top = (speeds.length - 1) * pitch + p.cellMm;
  const labelGap = Math.max(1.5, p.labelMm * 0.6);
  powers.forEach((power, c) => {
    for (const path of placeLabel(`${fmt(power)}%`, p.labelMm, c * pitch + p.cellMm / 2, top + labelGap, "centre")) out.push({ path, layer: "score" });
  });
  speeds.forEach((speed, r) => {
    const mid = r * pitch + p.cellMm / 2 - p.labelMm * 0.36; // roughly centres the text on the row
    for (const path of placeLabel(`${fmt(speed)} mm/s`, p.labelMm, -labelGap, mid, "right")) out.push({ path, layer: "score" });
  });
  return out;
}

export interface KerfTestParams {
  thicknessMm: number; // material thickness
  minWidthMm: number; // narrowest slot drawn
  stepMm: number; // width difference between neighbouring slots
  count: number;
  slotLengthMm: number;
  labelMm: number;
}

export function validateKerfTest(p: KerfTestParams): string | null {
  if (!(p.thicknessMm > 0) || !(p.minWidthMm > 0)) return "Thickness and the narrowest slot must be above 0.";
  if (!(p.stepMm > 0) || p.stepMm > 1) return "The step must be above 0 and at most 1 mm.";
  if (!Number.isInteger(p.count) || p.count < 2 || p.count > 20) return "Use 2 to 20 slots.";
  if (!(p.slotLengthMm >= 5) || !(p.labelMm >= 1.5)) return "Slots need to be at least 5 mm long, and labels at least 1.5 mm.";
  return null;
}

/** A coupon (cut outline) with slots of increasing width and a scored label under each. */
export function kerfTest(p: KerfTestParams): TestItem[] {
  const widths = Array.from({ length: p.count }, (_, i) => Math.round((p.minWidthMm + i * p.stepMm) * 1000) / 1000);
  const widest = widths[widths.length - 1]!;
  const pitch = widest + 6;
  const margin = 5;
  const labelH = p.labelMm + 4;
  const w = margin * 2 + p.count * pitch - 6 + widest * 0; // slots sit on a regular pitch
  const h = margin * 2 + p.slotLengthMm + labelH;
  const out: TestItem[] = [{ path: rectangle(w, h), layer: "cut" }];
  widths.forEach((sw, i) => {
    const cx = margin + i * pitch + widest / 2;
    out.push({ path: transformPath(rectangle(sw, p.slotLengthMm), translation(cx - sw / 2, margin + labelH)), layer: "cut" });
    for (const path of placeLabel(fmt(sw), p.labelMm, cx, margin, "centre")) out.push({ path, layer: "score" });
  });
  return out;
}
