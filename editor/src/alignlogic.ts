// Lining a design up on the camera picture: the maths, with no screen in it so it can be tested.
// Bed space is mm, Y up. The camera picture is pixels, Y down; `toBed` / `toCam` are the calibration's homography and its inverse.
import { applyH, invertH, solveHomographyLS, type Pt } from "./homography";
import { flatten, transformPath, type Matrix } from "./geometry";
import { fromJobObjects, type JobObject } from "./job";

export interface Calibration {
  imageWidth: number; imageHeight: number;
  points: { camera: [number, number]; bed: [number, number] }[];
  homography: number[];
  calibratedBy?: string; calibratedAt?: string;
}

/** The four bed corners in the order the teacher clicks them: the origin, then round the bed. Bed space always spans 0..width, 0..height. */
export const bedCorners = (w: number, h: number): Pt[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

/** Squares the laser cuts for calibration: each square's four corners in bed mm, in the order to click them (counter-clockwise from the lower left). */
export interface MarkSquare { square: number; corners: [number, number][] }

/** The reference points to click, in order: the bed's four corners, or every corner of each cut square. */
export const targetsFromSquares = (squares: MarkSquare[]): Pt[] => squares.flatMap((q) => q.corners.map(([x, y]) => ({ x, y })));

const turn = (p: Pt[]): number => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]!; return s + (r.x - q.x) * (r.y + q.y); }, 0);

/**
 * Build the calibration from camera points the teacher clicked, for the known bed points they stand for (in the same order, in
 * groups of four going round a rectangle). null if they cannot make a mapping: a group that crosses over or goes the wrong way
 * round (camera Y is flipped, so the right order turns the opposite way to the bed's), or a fit that misses its own points by 15 mm or more.
 */
export function makeCalibration(camPts: Pt[], bedPts: Pt[], imageWidth: number, imageHeight: number): Pick<Calibration, "imageWidth" | "imageHeight" | "points" | "homography"> | null {
  if (camPts.length < 4 || camPts.length !== bedPts.length || camPts.length % 4 !== 0) return null;
  for (let i = 0; i < camPts.length; i += 4) if (Math.sign(turn(camPts.slice(i, i + 4))) === Math.sign(turn(bedPts.slice(i, i + 4)))) return null;
  const h = solveHomographyLS(camPts, bedPts);
  if (!h || !invertH(h)) return null;
  const worst = Math.max(...camPts.map((c, i) => { const p = applyH(h, c); return Math.hypot(p.x - bedPts[i]!.x, p.y - bedPts[i]!.y); }));
  if (!(worst < 15)) return null;
  return { imageWidth, imageHeight, points: camPts.map((c, i) => ({ camera: [c.x, c.y] as [number, number], bed: [bedPts[i]!.x, bedPts[i]!.y] as [number, number] })), homography: h };
}

/** How far (mm) the mapping puts each clicked point from where it should be: the worst and the typical. */
export function fitError(camPts: Pt[], bedPts: Pt[], homography: number[]): { worst: number; mean: number } {
  const e = camPts.map((c, i) => { const p = applyH(homography, c); return Math.hypot(p.x - bedPts[i]!.x, p.y - bedPts[i]!.y); });
  return { worst: Math.max(...e), mean: e.reduce((a, b) => a + b, 0) / e.length };
}

export const toBed = (cal: Pick<Calibration, "homography">, p: Pt): Pt => applyH(cal.homography, p);
export function toCam(cal: Pick<Calibration, "homography">): (p: Pt) => Pt {
  const inv = invertH(cal.homography);
  return (p) => (inv ? applyH(inv, p) : { x: NaN, y: NaN });
}

/** A rigid placement: turn by `rot` radians (counter-clockwise, Y up) about `c`, then move by (dx, dy). As the server's [a,b,c,d,e,f] matrix. */
export function placementMatrix(rot: number, c: Pt, dx: number, dy: number): Matrix {
  const co = Math.cos(rot), si = Math.sin(rot);
  return [co, si, -si, co, c.x - co * c.x + si * c.y + dx, c.y - si * c.x - co * c.y + dy];
}

export function applyMatrix(m: number[], p: Pt): Pt {
  return { x: m[0]! * p.x + m[2]! * p.y + m[4]!, y: m[1]! * p.x + m[3]! * p.y + m[5]! };
}

export interface Shape { pts: Pt[]; layer: "cut" | "score"; closed: boolean }

/** The design as outlines in bed mm, where it sits now (before any placement). */
export function designShapes(objects: JobObject[]): Shape[] {
  return fromJobObjects(objects).map((sh) => ({ pts: flatten(transformPath(sh.path, sh.matrix), 0.2), layer: sh.layer, closed: sh.path.closed }));
}

export function boundsOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
}

export const centreOf = (pts: Pt[]): Pt => { const b = boundsOf(pts); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; };

/** True if every point is on the bed (a small tolerance for rounding). */
export const fitsBed = (pts: Pt[], bedW: number, bedH: number, tolMm = 0.01): boolean =>
  pts.every((p) => p.x >= -tolMm && p.y >= -tolMm && p.x <= bedW + tolMm && p.y <= bedH + tolMm);

/** The angle (radians, counter-clockwise) of the line from `c` to `p`. */
export const angleOf = (c: Pt, p: Pt): number => Math.atan2(p.y - c.y, p.x - c.x);

/** Wrap to (-180, 180] degrees for showing. */
export const degrees = (rad: number): number => { let d = (rad * 180) / Math.PI; d = ((d + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d; };
