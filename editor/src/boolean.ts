// Boolean operations (union, intersect, subtract) on closed shapes, via paper.js.
// Operands are lists of closed contours (a group or text object is one compound operand, even-odd).
// paper works in Beziers, so results are post-processed: curves that are really circular arcs
// become true arcs again, and neighbouring arcs of one circle are merged.
import paper from "paper";
import type { Point } from "./coords";
import { arcMid, arcSweep, type Path, type Seg } from "./geometry";

export type BoolOp = "union" | "intersect" | "subtract";

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

let scope: paper.PaperScope | null = null;
function sc(): paper.PaperScope {
  if (!scope) { scope = new paper.PaperScope(); scope.setup(new scope.Size(1, 1)); }
  return scope;
}

function toPaper(s: paper.PaperScope, path: Path): paper.Path {
  const P = (p: Point) => new s.Point(p.x, p.y);
  const out = new s.Path();
  out.moveTo(P(path.start));
  let cur = path.start;
  for (const g of path.segs) {
    if (g.t === "l") out.lineTo(P(g.to));
    else if (g.t === "c") out.cubicCurveTo(P(g.c1), P(g.c2), P(g.to));
    else out.arcTo(P(arcMid(g.c, cur, g.to, g.ccw)), P(g.to));
    cur = g.to;
  }
  if (path.closed) {
    const first = out.firstSegment, last = out.lastSegment;
    if (out.segments.length > 1 && first.point.getDistance(last.point) < 1e-9) { // the path already returns to its start: merge
      first.handleIn = last.handleIn;
      last.remove();
    }
    out.closed = true;
  }
  return out as paper.Path;
}

function toOperand(s: paper.PaperScope, contours: Path[]): paper.PathItem {
  if (contours.length === 1) return toPaper(s, contours[0]!);
  const c = new s.CompoundPath({ fillRule: "evenodd" });
  for (const p of contours) c.addChild(toPaper(s, p));
  return c;
}

// ---- paper -> Path ----

const tol = 1e-4;

export interface Circle { c: Point; r: number }

/**
 * If a cubic is a circular arc (to within tolerance), return it as an arc segment. Circles that already exist in the
 * input (`known`) are preferred, so arcs recovered after a boolean sit exactly on the original circle.
 */
export function cubicAsArc(p0: Point, c1: Point, c2: Point, p3: Point, known: Circle[] = []): Seg | null {
  const at = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    };
  };
  const m = at(0.5);
  const cross = (m.x - p0.x) * (p3.y - m.y) - (m.y - p0.y) * (p3.x - m.x);
  const chord = dist(p0, p3);
  if (chord < 1e-9 || Math.abs(cross) < 1e-9 * chord * chord) return null; // straight
  const samples = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1].map(at);
  const onCircle = (c: Point, r: number) => samples.every((q) => Math.abs(dist(c, q) - r) <= 6e-4 * r + 1e-6); // a 90-degree Bezier arc is off by ~2.7e-4 r
  for (const k of known) if (onCircle(k.c, k.r)) return { t: "a", c: k.c, to: p3, ccw: cross > 0 };
  // circumcentre of p0, m, p3
  const d = 2 * (p0.x * (m.y - p3.y) + m.x * (p3.y - p0.y) + p3.x * (p0.y - m.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = p0.x * p0.x + p0.y * p0.y, b2 = m.x * m.x + m.y * m.y, c2n = p3.x * p3.x + p3.y * p3.y;
  const centre = {
    x: (a2 * (m.y - p3.y) + b2 * (p3.y - p0.y) + c2n * (p0.y - m.y)) / d,
    y: (a2 * (p3.x - m.x) + b2 * (p0.x - p3.x) + c2n * (m.x - p0.x)) / d,
  };
  if (!onCircle(centre, dist(centre, p0))) return null;
  return { t: "a", c: centre, to: p3, ccw: cross > 0 };
}

function fromContour(p: paper.Path, known: Circle[]): Path | null {
  const segs = p.segments;
  const n = segs.length;
  if (n < 2) return null;
  const pt = (s: paper.Segment): Point => ({ x: s.point.x, y: s.point.y });
  const out: Seg[] = [];
  let cur = pt(segs[0]!);
  const count = p.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = segs[i]!, b = segs[(i + 1) % n]!;
    const to = pt(b);
    if (a.handleOut.isZero() && b.handleIn.isZero()) out.push({ t: "l", to });
    else {
      const c1 = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
      const c2 = { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y };
      out.push(cubicAsArc(cur, c1, c2, to, known) ?? { t: "c", c1, c2, to });
    }
    cur = to;
  }
  const start = pt(segs[0]!);
  const merged = mergeArcs(start, out);
  return p.closed ? mergeWrap(start, merged) : { start, segs: merged, closed: false };
}

/** Merge consecutive arcs of the same circle and direction, as long as they add up to less than a full turn. */
export function mergeArcs(start: Point, segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  const starts: Point[] = []; // start point of each output segment
  let cur = start;
  for (const g of segs) {
    const prev = out[out.length - 1];
    if (g.t === "a" && prev && prev.t === "a" && prev.ccw === g.ccw && dist(prev.c, g.c) < 1e-3 &&
        Math.abs(dist(prev.c, starts[starts.length - 1]!) - dist(g.c, cur)) < 5e-3 * Math.max(1, dist(g.c, cur))) {
      const total = Math.abs(arcSweep(prev.c, starts[starts.length - 1]!, prev.to, prev.ccw)) + Math.abs(arcSweep(g.c, cur, g.to, g.ccw));
      if (total < Math.PI * 2 - 1e-3) { out[out.length - 1] = { t: "a", c: prev.c, to: g.to, ccw: g.ccw }; cur = g.to; continue; }
    }
    out.push(g);
    starts.push(cur);
    cur = g.to;
  }
  return out;
}

/** A closed contour may start in the middle of an arc: join its last and first arcs by moving the start back. */
function mergeWrap(start: Point, segs: Seg[]): Path {
  const first = segs[0], last = segs[segs.length - 1];
  if (segs.length >= 2 && first?.t === "a" && last?.t === "a" && first.ccw === last.ccw && dist(first.c, last.c) < 1e-3) {
    const lastStart = segs.length >= 2 ? segs[segs.length - 2]!.to : start;
    const total = Math.abs(arcSweep(last.c, lastStart, last.to, last.ccw)) + Math.abs(arcSweep(first.c, start, first.to, first.ccw));
    if (total < Math.PI * 2 - 1e-3) {
      return { start: lastStart, segs: [{ t: "a", c: last.c, to: first.to, ccw: first.ccw }, ...segs.slice(1, -1)], closed: true };
    }
  }
  return { start, segs, closed: true };
}

function contoursOf(item: paper.Item, known: Circle[]): Path[] {
  const children: paper.Path[] =
    item instanceof paper.CompoundPath || (item as paper.Item).className === "CompoundPath"
      ? ((item as paper.CompoundPath).children as paper.Path[])
      : [item as paper.Path];
  const out: Path[] = [];
  for (const c of children) {
    if (!c.segments || Math.abs(c.area) < 1e-6) continue;
    const p = fromContour(c, known);
    if (p) out.push(p);
  }
  return out;
}

/** The exact circles behind a path's arcs. */
function circlesOf(path: Path): Circle[] {
  const out: Circle[] = [];
  let cur = path.start;
  for (const g of path.segs) {
    if (g.t === "a") out.push({ c: g.c, r: dist(cur, g.c) });
    cur = g.to;
  }
  return out;
}

export interface BoolResult { paths: Path[]; error?: string }

/**
 * Combine operands. For "subtract" the first operand is the base and every other operand is removed from it.
 * All contours must be closed.
 */
export function booleanOp(op: BoolOp, operands: Path[][]): BoolResult {
  if (operands.length < 2) return { paths: [], error: "Select at least two shapes." };
  if (operands.some((o) => o.some((p) => !p.closed))) return { paths: [], error: "Boolean operations need closed shapes. Close open paths first." };
  const s = sc();
  s.project.clear();
  try {
    let acc: paper.PathItem = toOperand(s, operands[0]!);
    for (const next of operands.slice(1)) {
      const b = toOperand(s, next);
      acc = op === "union" ? acc.unite(b) : op === "intersect" ? acc.intersect(b) : acc.subtract(b);
    }
    const known: Circle[] = operands.flat().flatMap((p) => circlesOf(p));
    const paths = contoursOf(acc, known);
    return paths.length ? { paths } : { paths, error: op === "intersect" ? "The shapes do not overlap." : "Nothing is left." };
  } finally {
    s.project.clear();
  }
}
