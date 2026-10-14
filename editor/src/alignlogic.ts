// Lining a design up on the camera picture: the maths, with no screen in it so it can be tested.
// Bed space is mm, Y up. The camera picture is pixels, Y down; `toBed` / `toCam` are the calibration's homography and its inverse.
import { applyH, invertH, solveHomography, type H, type Pt } from "./homography";
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

/** Build the calibration from four clicked points (camera pixels) for a bed of this size. null if the clicks cannot make a mapping. */
export function makeCalibration(camPts: Pt[], bedW: number, bedH: number, imageWidth: number, imageHeight: number): Pick<Calibration, "imageWidth" | "imageHeight" | "points" | "homography"> | null {
  const corners = bedCorners(bedW, bedH);
  const h = solveHomography(camPts, corners);
  if (!h || !invertH(h)) return null;
  // a good set of clicks keeps the corners in the same turning order as the bed's; a twisted one is a mis-click
  const turn = (p: Pt[]) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]!; return s + (r.x - q.x) * (r.y + q.y); }, 0);
  if (Math.sign(turn(camPts)) === Math.sign(turn(corners))) return null; // camera Y is flipped, so the right order turns the opposite way round
  return { imageWidth, imageHeight, points: camPts.map((c, i) => ({ camera: [c.x, c.y] as [number, number], bed: [corners[i]!.x, corners[i]!.y] as [number, number] })), homography: h };
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
