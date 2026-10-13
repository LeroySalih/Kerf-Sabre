// Repeat tools: linear repeat in two directions, circular array, and mirror. Pure; bed space (mm, Y-up).
import type { Point } from "./coords";
import type { Bounds, Matrix } from "./geometry";

/** A repeat may not create more shapes than this, so a typo can't freeze the page. */
export const MAX_COPIES = 2000;

export interface LinearParams {
  countX: number; // total columns, including the original
  countY: number; // total rows, including the original
  gapX: number; // space between neighbouring shapes (mm), edge to edge
  gapY: number;
  /** Extra X shift applied to each further row, for brick patterns. */
  rowShiftMm: number;
}

export function validateLinear(p: LinearParams): string | null {
  if (![p.countX, p.countY].every((n) => Number.isInteger(n) && n >= 1)) return "Use whole numbers of 1 or more for the counts.";
  if (p.countX * p.countY < 2) return "Make at least 2 copies in total (count X or count Y above 1).";
  if (p.countX * p.countY - 1 > MAX_COPIES) return `That would make more than ${MAX_COPIES} copies.`;
  if (![p.gapX, p.gapY, p.rowShiftMm].every(Number.isFinite)) return "Gaps and shift must be numbers.";
  return null;
}

/** Translation of every copy relative to the original (the original, at 0,0, is not included). Columns go +X, rows go +Y. */
export function linearOffsets(b: Bounds, p: LinearParams): Point[] {
  const pitchX = b.maxX - b.minX + p.gapX;
  const pitchY = b.maxY - b.minY + p.gapY;
  const out: Point[] = [];
  for (let r = 0; r < p.countY; r++)
    for (let c = 0; c < p.countX; c++) {
      if (r === 0 && c === 0) continue;
      out.push({ x: c * pitchX + r * p.rowShiftMm, y: r * pitchY });
    }
  return out;
}

export interface CircularParams {
  count: number; // total shapes around the circle, including the original
  sweepDeg: number; // 360 = full circle; counter-clockwise positive
  centre: Point; // the circle's centre
  /** Turn each copy to follow the circle (true), or keep them all facing the same way (false). */
  rotate: boolean;
}

export function validateCircular(p: CircularParams): string | null {
  if (!Number.isInteger(p.count) || p.count < 2) return "Use at least 2 shapes around the circle.";
  if (p.count - 1 > MAX_COPIES) return `That would make more than ${MAX_COPIES} copies.`;
  if (!Number.isFinite(p.sweepDeg) || p.sweepDeg === 0 || Math.abs(p.sweepDeg) > 360) return "The sweep angle must be between -360 and 360 degrees, and not 0.";
  if (!Number.isFinite(p.centre.x) || !Number.isFinite(p.centre.y)) return "The centre must be a point.";
  return null;
}

/** Angle between neighbours: a full turn is split evenly (no copy on top of the original); a partial sweep ends on the last copy. */
export function circularStep(p: Pick<CircularParams, "count" | "sweepDeg">): number {
  return Math.abs(p.sweepDeg) >= 360 ? p.sweepDeg / p.count : p.sweepDeg / (p.count - 1);
}

const rotateAbout = (c: Point, rad: number): Matrix => {
  const k = Math.cos(rad), s = Math.sin(rad);
  return [k, s, -s, k, c.x - k * c.x + s * c.y, c.y - s * c.x - k * c.y];
};

/** One matrix per extra copy (the original is not included), to apply on top of each shape's own placement. */
export function circularMatrices(b: Bounds, p: CircularParams): Matrix[] {
  const step = circularStep(p);
  const mid: Point = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  return Array.from({ length: p.count - 1 }, (_, i) => {
    const rad = (step * (i + 1) * Math.PI) / 180;
    const turned = rotateAbout(p.centre, rad);
    if (p.rotate) return turned;
    // keep the orientation: move the shape's centre to where it would have gone
    const target = { x: turned[0] * mid.x + turned[2] * mid.y + turned[4], y: turned[1] * mid.x + turned[3] * mid.y + turned[5] };
    return [1, 0, 0, 1, target.x - mid.x, target.y - mid.y];
  });
}

/** Flip left-right ("h") or top-bottom ("v") about the bounds' own centre, so the shape stays where it is. */
export function mirrorMatrix(b: Bounds, axis: "h" | "v"): Matrix {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return axis === "h" ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy];
}
