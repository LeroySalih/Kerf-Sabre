// Geometry model: paths of line, arc and cubic Bezier segments. mm, Y-up.
// Design geometry is never mutated; objects carry a matrix (Design -> Bed).
import type { Point } from "./coords";

export type Seg =
  | { t: "l"; to: Point }
  | { t: "a"; c: Point; to: Point; ccw: boolean } // true arc about centre c (radius = |start - c|)
  | { t: "c"; c1: Point; c2: Point; to: Point };

export interface Path {
  start: Point;
  segs: Seg[];
  closed: boolean;
}

/** Affine matrix [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  // result = m * n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translation = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];

const det = (m: Matrix) => m[0] * m[3] - m[1] * m[2];

/** True if the matrix is rotation + uniform scale (+ optional mirror): arcs stay arcs. */
export function isSimilarity(m: Matrix, eps = 1e-9): boolean {
  return Math.abs(m[0] * m[2] + m[1] * m[3]) < eps && Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < eps;
}

const TAU = Math.PI * 2;
const mod = (a: number) => ((a % TAU) + TAU) % TAU;

/** Signed sweep (radians, + = ccw) of an arc from `from` to `to` about `c`. */
export function arcSweep(c: Point, from: Point, to: Point, ccw: boolean): number {
  const a0 = Math.atan2(from.y - c.y, from.x - c.x);
  const a1 = Math.atan2(to.y - c.y, to.x - c.x);
  return ccw ? mod(a1 - a0) : -mod(a0 - a1);
}

/** A point on the arc halfway along it. */
export function arcMid(c: Point, from: Point, to: Point, ccw: boolean): Point {
  const r = Math.hypot(from.x - c.x, from.y - c.y);
  const a = Math.atan2(from.y - c.y, from.x - c.x) + arcSweep(c, from, to, ccw) / 2;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

/** Approximate an arc with cubic Beziers (<= 90 degrees each). */
export function arcToCubics(c: Point, from: Point, to: Point, ccw: boolean): Seg[] {
  const sweep = arcSweep(c, from, to, ccw);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const r = Math.hypot(from.x - c.x, from.y - c.y);
  const k = (4 / 3) * Math.tan(step / 4);
  let a = Math.atan2(from.y - c.y, from.x - c.x);
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const p0 = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
    const p3 = i === n - 1 ? to : { x: c.x + r * Math.cos(b), y: c.y + r * Math.sin(b) };
    out.push({
      t: "c",
      c1: { x: p0.x - k * r * Math.sin(a), y: p0.y + k * r * Math.cos(a) },
      c2: { x: p3.x + k * r * Math.sin(b), y: p3.y - k * r * Math.cos(b) },
      to: p3,
    });
    a = b;
  }
  return out;
}

/** Transform a path by a matrix. Arcs stay arcs under similarities, else become cubics. */
export function transformPath(path: Path, m: Matrix): Path {
  const keepArcs = isSimilarity(m);
  const flip = det(m) < 0;
  const segs: Seg[] = [];
  let cur = path.start;
  for (const s of path.segs) {
    if (s.t === "l") segs.push({ t: "l", to: apply(m, s.to) });
    else if (s.t === "c") segs.push({ t: "c", c1: apply(m, s.c1), c2: apply(m, s.c2), to: apply(m, s.to) });
    else if (keepArcs) segs.push({ t: "a", c: apply(m, s.c), to: apply(m, s.to), ccw: flip ? !s.ccw : s.ccw });
    else for (const cs of arcToCubics(s.c, cur, s.to, s.ccw)) segs.push(transformSeg(cs, m));
    cur = s.to;
  }
  return { start: apply(m, path.start), segs, closed: path.closed };
}

function transformSeg(s: Seg, m: Matrix): Seg {
  if (s.t === "c") return { t: "c", c1: apply(m, s.c1), c2: apply(m, s.c2), to: apply(m, s.to) };
  if (s.t === "l") return { t: "l", to: apply(m, s.to) };
  throw new Error("unexpected arc");
}

function cubicAt(p0: Point, s: { c1: Point; c2: Point; to: Point }, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
    y: u * u * u * p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
  };
}

/** Polyline approximation (for bounds, hit-testing and DXF export of curves). */
export function flatten(path: Path, tolMm = 0.05): Point[] {
  const pts: Point[] = [path.start];
  let cur = path.start;
  for (const s of path.segs) {
    if (s.t === "l") pts.push(s.to);
    else if (s.t === "c") {
      const len = Math.hypot(s.c1.x - cur.x, s.c1.y - cur.y) + Math.hypot(s.c2.x - s.c1.x, s.c2.y - s.c1.y) + Math.hypot(s.to.x - s.c2.x, s.to.y - s.c2.y);
      const n = Math.max(4, Math.ceil(Math.sqrt(len / tolMm)));
      for (let i = 1; i <= n; i++) pts.push(cubicAt(cur, s, i / n));
    } else {
      const sweep = arcSweep(s.c, cur, s.to, s.ccw);
      const r = Math.hypot(cur.x - s.c.x, cur.y - s.c.y);
      const da = r > tolMm ? 2 * Math.acos(1 - tolMm / r) : Math.PI / 2;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / da));
      const a0 = Math.atan2(cur.y - s.c.y, cur.x - s.c.x);
      for (let i = 1; i < n; i++) pts.push({ x: s.c.x + r * Math.cos(a0 + (sweep * i) / n), y: s.c.y + r * Math.sin(a0 + (sweep * i) / n) });
      pts.push(s.to);
    }
    cur = s.to;
  }
  return pts;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** Exact bounds: flattened curve points plus the cardinal extremes of every true arc. */
export function boundsOf(path: Path): Bounds {
  const pts = flatten(path);
  let cur = path.start;
  for (const s of path.segs) {
    if (s.t === "a") {
      const r = Math.hypot(cur.x - s.c.x, cur.y - s.c.y);
      const a0 = Math.atan2(cur.y - s.c.y, cur.x - s.c.x);
      const sweep = arcSweep(s.c, cur, s.to, s.ccw);
      for (let k = 0; k < 4; k++) {
        const target = (k * Math.PI) / 2;
        const d = s.ccw ? mod(target - a0) : -mod(a0 - target);
        if (Math.abs(d) <= Math.abs(sweep)) pts.push({ x: s.c.x + r * Math.cos(target), y: s.c.y + r * Math.sin(target) });
      }
    }
    cur = s.to;
  }
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };
}

// ---- Shape constructors (design space) ----

export function rectangle(w: number, h: number): Path {
  return {
    start: { x: 0, y: 0 },
    segs: [{ t: "l", to: { x: w, y: 0 } }, { t: "l", to: { x: w, y: h } }, { t: "l", to: { x: 0, y: h } }],
    closed: true,
  };
}

/** Circle centred on the origin, as two true 180-degree arcs. */
export function circle(r: number): Path {
  return {
    start: { x: r, y: 0 },
    segs: [
      { t: "a", c: { x: 0, y: 0 }, to: { x: -r, y: 0 }, ccw: true },
      { t: "a", c: { x: 0, y: 0 }, to: { x: r, y: 0 }, ccw: true },
    ],
    closed: true,
  };
}

export function line(dx: number, dy: number): Path {
  return { start: { x: 0, y: 0 }, segs: [{ t: "l", to: { x: dx, y: dy } }], closed: false };
}

/** Regular polygon centred on the origin. The first vertex is at `startRad` (counter-clockwise from +X), radius `r` to every vertex. */
export function regularPolygon(sides: number, r: number, startRad = 0): Path {
  const n = Math.max(3, Math.round(sides));
  const v = (k: number): Point => ({ x: r * Math.cos(startRad + (2 * Math.PI * k) / n), y: r * Math.sin(startRad + (2 * Math.PI * k) / n) });
  return { start: v(0), segs: Array.from({ length: n - 1 }, (_, i): Seg => ({ t: "l", to: v(i + 1) })), closed: true };
}

/** Straight-line path through absolute points (bed mm). Needs 2+ points, or 3+ to close. Returns null otherwise. */
export function polylinePath(points: Point[], closed: boolean): Path | null {
  if (points.length < (closed ? 3 : 2)) return null;
  return { start: points[0]!, segs: points.slice(1).map((to): Seg => ({ t: "l", to })), closed };
}
