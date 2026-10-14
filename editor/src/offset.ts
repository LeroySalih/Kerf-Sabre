// Offset: draw a parallel copy of a shape (or open line) a given distance away.
// The geometry is done by Clipper on a finely flattened outline, then the result is turned back into true lines
// and arcs: offsetting an arc gives a concentric arc, and a rounded corner is an arc about the old corner, so
// those circles are known in advance and the output is recognised against them. Pure; mm, Y-up.
import ClipperLib from "clipper-lib";
import type { Point } from "./coords";
import { flatten, type Path, type Seg } from "./geometry";
import { explicit } from "./trim";

export type OffsetSide = "outside" | "inside" | "both";
export type OffsetCorner = "round" | "sharp";

export interface OffsetOptions {
  distance: number;
  /** Closed shapes: away from / towards the inside. Open lines: left / right of the way they run. "both" gives two curves. */
  side: OffsetSide;
  corner: OffsetCorner;
}

const SCALE = 10000; // Clipper works in integers: 0.1 micrometre steps
const FLAT_TOL = 0.003;
const ARC_TOL = 0.002;
const FIT_TOL = 0.003; // a point this close to a known circle is on it
const MITRE_LIMIT = 3;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface Circle { c: Point; r: number }

const toInt = (p: Point) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) });
const fromInt = (p: { X: number; Y: number }): Point => ({ x: p.X / SCALE, y: p.Y / SCALE });

function area(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1]!, p) > 1e-7) out.push(p);
  return out;
}

/** Circles the offset can contain: arcs of the source (radius +/- d) and a circle of radius d about each source node. */
function knownCircles(path: Path, d: number): Circle[] {
  const out: Circle[] = [];
  const q = explicit(path);
  let cur = q.start;
  const nodes = [q.start];
  for (const s of q.segs) {
    if (s.t === "a") {
      const r = dist(cur, s.c);
      out.push({ c: s.c, r: r + d });
      if (r - d > 1e-6) out.push({ c: s.c, r: r - d });
    }
    nodes.push(s.to);
    cur = s.to;
  }
  for (const n of nodes) out.push({ c: n, r: d });
  return out;
}

// ---------------------------------------------------------------- polyline -> lines and arcs

const MAX_ARC = 1.5 * Math.PI; // longer runs are split so no arc is more than three quarters of a turn

/** Turn a polyline into line and arc segments, using arcs wherever consecutive points lie on a known circle. */
export function fitSegments(points: Point[], circles: Circle[]): { start: Point; segs: Seg[] } {
  const pts = points.map((p) => ({ ...p }));
  const segs: Seg[] = [];
  let i = 0;
  const n = pts.length;
  while (i < n - 1) {
    let best: { j: number; c: Circle; ccw: boolean } | null = null;
    for (const circ of circles) {
      if (Math.abs(dist(pts[i]!, circ.c) - circ.r) > FIT_TOL) continue;
      let j = i, sweep = 0, dir = 0;
      while (j + 1 < n && Math.abs(dist(pts[j + 1]!, circ.c) - circ.r) <= FIT_TOL) {
        const a0 = Math.atan2(pts[j]!.y - circ.c.y, pts[j]!.x - circ.c.x), a1 = Math.atan2(pts[j + 1]!.y - circ.c.y, pts[j + 1]!.x - circ.c.x);
        let da = a1 - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) < 1e-9 || (dir !== 0 && Math.sign(da) !== dir)) break;
        dir = Math.sign(da);
        if (Math.abs(sweep + da) > MAX_ARC) break;
        sweep += da;
        j++;
      }
      if (j >= i + 2 && (!best || j > best.j)) best = { j, c: circ, ccw: dir > 0 };
    }
    if (best) {
      const c = best.c.c, r = best.c.r;
      const onCircle = (p: Point): Point => { const k = dist(p, c) || 1; return { x: c.x + ((p.x - c.x) * r) / k, y: c.y + ((p.y - c.y) * r) / k }; };
      pts[i] = onCircle(pts[i]!); // both ends exactly on the circle, so the arc's radius is the same at each end
      if (segs.length) segs[segs.length - 1]!.to = pts[i]!;
      pts[best.j] = onCircle(pts[best.j]!);
      segs.push({ t: "a", c, to: pts[best.j]!, ccw: best.ccw });
      i = best.j;
    } else {
      segs.push({ t: "l", to: pts[i + 1]! });
      i++;
    }
  }
  return { start: pts[0]!, segs: mergeLines(pts[0]!, segs) };
}

/** Ramer-Douglas-Peucker: drop points that lie within `tol` of the line through their neighbours. */
function rdp(pts: Point[], tol: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  let worst = -1, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len < 1e-12 ? dist(pts[i]!, a) : Math.abs(dx * (pts[i]!.y - a.y) - dy * (pts[i]!.x - a.x)) / len;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [a, b];
  return [...rdp(pts.slice(0, at + 1), tol).slice(0, -1), ...rdp(pts.slice(at), tol)];
}

/** A curve that was flattened to many tiny lines becomes far fewer, within a few thousandths of a millimetre of it. */
function simplifyLines(start: Point, segs: Seg[], tol = 0.004): Seg[] {
  const out: Seg[] = [];
  let run: Point[] = [];
  let cur = start;
  const flush = () => { if (run.length) { for (const p of rdp([run[0]!, ...run.slice(1)], tol).slice(1)) out.push({ t: "l", to: p }); run = []; } };
  for (const s of segs) {
    if (s.t === "l") { if (!run.length) run = [cur]; run.push(s.to); }
    else { flush(); out.push(s); }
    cur = s.to;
  }
  flush();
  return out;
}

/** Join consecutive straight segments that continue in one direction. */
function mergeLines(start: Point, segs: Seg[]): Seg[] {
  segs = simplifyLines(start, segs);
  const out: Seg[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (s.t === "l" && prev && prev.t === "l") {
      const a = out.length > 1 ? out[out.length - 2]!.to : start;
      const dx = s.to.x - a.x, dy = s.to.y - a.y, len = Math.hypot(dx, dy) || 1;
      if (Math.abs((prev.to.x - a.x) * dy - (prev.to.y - a.y) * dx) / len < 1e-3) { prev.to = s.to; continue; }
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- the offset

function newOffset(corner: OffsetCorner) {
  const co = new ClipperLib.ClipperOffset(MITRE_LIMIT, ARC_TOL * SCALE);
  return { co, join: corner === "round" ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter };
}

function offsetClosed(path: Path, d: number, corner: OffsetCorner): Point[][] {
  let ring = dedupe(flatten(explicit(path), FLAT_TOL));
  if (ring.length > 1 && dist(ring[0]!, ring[ring.length - 1]!) < 1e-7) ring.pop();
  if (ring.length < 3) return [];
  if (area(ring) < 0) ring = ring.reverse(); // Clipper grows counter-clockwise rings for a positive delta
  const { co, join } = newOffset(corner);
  co.AddPath(ring.map(toInt), join, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, d * SCALE);
  return sol.map((r) => r.map(fromInt)).filter((r) => r.length >= 3);
}

/** Signed side of `v` relative to the polyline `line`: +1 left of its direction, -1 right, 0 if it is not at distance `d` from it. */
function sideOf(v: Point, line: Point[], d: number): number {
  let best = Infinity, side = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!, b = line[i + 1]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) continue;
    const t = Math.min(1, Math.max(0, ((v.x - a.x) * dx + (v.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const k = dist(v, q);
    if (k < best - 1e-9) { best = k; side = Math.sign(dx * (v.y - q.y) - dy * (v.x - q.x)); }
  }
  return Math.abs(best - d) <= Math.max(0.01, d * 0.02) ? side : 0;
}

/** One-sided offsets of an open line: the stroke around it is built by Clipper, then split into its left and right edges. */
function offsetOpen(path: Path, d: number, corner: OffsetCorner): { left: Point[][]; right: Point[][] } {
  const line = dedupe(flatten(path, FLAT_TOL));
  if (line.length < 2) return { left: [], right: [] };
  const { co, join } = newOffset(corner);
  co.AddPath(line.map(toInt), join, ClipperLib.EndType.etOpenButt);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, d * SCALE);
  const left: Point[][] = [], right: Point[][] = [];
  for (const raw of sol) {
    const ring = raw.map(fromInt);
    const sides = ring.map((v) => sideOf(v, line, d));
    const start = sides.findIndex((s, i) => s !== sides[(i + sides.length - 1) % sides.length]);
    if (start < 0) continue;
    let run: Point[] = [], runSide = 0;
    const flush = () => {
      if (run.length >= 2 && runSide !== 0) {
        const along = dist(run[0]!, line[0]!) <= dist(run[run.length - 1]!, line[0]!) ? run : run.slice().reverse(); // oriented like the source line
        (runSide > 0 ? left : right).push(along);
      }
      run = [];
    };
    for (let k = 0; k < ring.length; k++) {
      const i = (start + k) % ring.length;
      if (sides[i] !== runSide) { flush(); runSide = sides[i]!; }
      run.push(ring[i]!);
    }
    flush();
  }
  return { left, right };
}

/** Offset one (placed) path. Returns the new paths: none if the offset has collapsed. */
export function offsetPath(path: Path, o: OffsetOptions): Path[] {
  const d = o.distance;
  if (!(d > 0) || path.segs.length === 0) return [];
  const circles = knownCircles(path, d);
  const out: Path[] = [];
  const emit = (pts: Point[], closed: boolean) => {
    const poly = closed ? [...pts, pts[0]!] : pts;
    const fitted = fitSegments(poly, circles);
    const segs = fitted.segs;
    if (closed && segs.length) { // the ring must end exactly where it began
      const last = segs[segs.length - 1]!, prev = segs[segs.length - 2];
      const from = prev ? prev.to : fitted.start;
      if (last.t === "l" && prev && prev.t === "a" && dist(from, last.to) < 0.02) { segs.pop(); prev.to = fitted.start; } // a sliver left by the half-turn arc limit
      else last.to = fitted.start;
    }
    if (segs.length) out.push({ start: fitted.start, segs, closed });
  };
  if (path.closed) {
    if (o.side !== "inside") offsetClosed(path, d, o.corner).forEach((r) => emit(r, true));
    if (o.side !== "outside") offsetClosed(path, -d, o.corner).forEach((r) => emit(r, true));
  } else {
    const { left, right } = offsetOpen(path, d, o.corner);
    // "outside" = left of the way the line runs, "inside" = right
    if (o.side !== "inside") left.forEach((r) => emit(r, false));
    if (o.side !== "outside") right.forEach((r) => emit(r, false));
  }
  return out;
}

