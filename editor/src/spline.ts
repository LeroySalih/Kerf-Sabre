// Splines: a smooth curve through the points you click. The curve is a chain of cubic Beziers (centripetal
// Catmull-Rom, so it passes through every point and doesn't loop or overshoot at uneven spacing). Pure; mm.
import type { Point } from "./coords";
import type { Path, Seg } from "./geometry";

/** What makes a shape a spline: the points the curve passes through (design space), and whether it closes. */
export interface SplineSpec {
  points: Point[];
  closed: boolean;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const EPS = 1e-6;

/** The points with repeated neighbours removed (and, for a closed curve, a last point equal to the first). */
export function cleanPoints(points: Point[], closed: boolean): Point[] {
  const out: Point[] = [];
  for (const p of points) if (!out.length || dist(out[out.length - 1]!, p) > EPS) out.push(p);
  if (closed && out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= EPS) out.pop();
  return out;
}

/** Bezier control points for the segment p1 -> p2 given its neighbours p0 and p3 (centripetal parametrisation, alpha = 0.5). */
function controls(p0: Point, p1: Point, p2: Point, p3: Point): [Point, Point] {
  const d1 = Math.sqrt(dist(p0, p1)), d2 = Math.sqrt(dist(p1, p2)), d3 = Math.sqrt(dist(p2, p3));
  const a1 = d1 * d1, a2 = d2 * d2, a3 = d3 * d3;
  const c = (k: number, pa: Point, pb: Point, pc: Point, da: number, db: number, sa: number, sb: number): Point => {
    // (sa * pa - sb * pc + (2 sa + 3 da db + sb) * pb) / (3 da (da + db)), with the roles named per call below
    const den = 3 * da * (da + db);
    return den < EPS ? pb : { x: (sa * pa.x - sb * pc.x + k * pb.x) / den, y: (sa * pa.y - sb * pc.y + k * pb.y) / den };
  };
  const c1 = c(2 * a1 + 3 * d1 * d2 + a2, p2, p1, p0, d1, d2, a1, a2);
  const c2 = c(2 * a3 + 3 * d3 * d2 + a2, p1, p2, p3, d3, d2, a3, a2);
  return [c1, c2];
}

/**
 * A smooth path through `points`. Two points make a straight line. Null when there are too few distinct points
 * (2 for an open curve, 3 for a closed one).
 */
export function splinePath(points: Point[], closed: boolean): Path | null {
  const pts = cleanPoints(points, closed);
  const n = pts.length;
  if (n < (closed ? 3 : 2)) return null;
  if (n === 2) return { start: pts[0]!, segs: [{ t: "l", to: pts[1]! }], closed: false };
  const at = (i: number): Point => {
    if (closed) return pts[((i % n) + n) % n]!;
    if (i < 0) return { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y }; // mirror the first neighbour for the end tangent
    if (i >= n) return { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
    return pts[i]!;
  };
  const segs: Seg[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const [c1, c2] = controls(at(i - 1), at(i), at(i + 1), at(i + 2));
    segs.push({ t: "c", c1, c2, to: at(i + 1) });
  }
  return { start: pts[0]!, segs, closed };
}
