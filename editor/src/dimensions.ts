// Dimensions: annotations that make a design easy to read. They are drawn in the Editor and saved with the job,
// but they are not shapes: they are never cut, never exported to DXF/SVG, and never turned into G-code.
// Pure; bed space, mm.
import type { Point } from "./coords";
import { arcSweep, type Path } from "./geometry";

export type DimAxis = "aligned" | "horizontal" | "vertical";

export interface LinearDim {
  id: string;
  kind: "linear";
  axis: DimAxis;
  a: Point;
  b: Point;
  /** Distance of the dimension line beyond the measured points, along the normal (see `dimGeometry`). */
  offsetMm: number;
}

export interface RadialDim {
  id: string;
  kind: "radial";
  center: Point;
  radiusMm: number;
  /** Where on the circle the leader meets it, as an angle from +X (counter-clockwise). */
  angleRad: number;
  diameter: boolean;
}

export type Dimension = LinearDim | RadialDim;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

export const fmtMm = (n: number): string => String(Math.round(n * 100) / 100);

/** Unit direction the linear dimension measures along. */
export function linearAxis(d: LinearDim): Point {
  if (d.axis === "horizontal") return { x: 1, y: 0 };
  if (d.axis === "vertical") return { x: 0, y: 1 };
  const l = dist(d.a, d.b) || 1;
  return { x: (d.b.x - d.a.x) / l, y: (d.b.y - d.a.y) / l };
}

export function dimValue(d: Dimension): number {
  if (d.kind === "radial") return d.diameter ? d.radiusMm * 2 : d.radiusMm;
  return Math.abs(dot({ x: d.b.x - d.a.x, y: d.b.y - d.a.y }, linearAxis(d)));
}

export const dimLabel = (d: Dimension): string => (d.kind === "radial" ? (d.diameter ? "Ø" : "R") : "") + fmtMm(dimValue(d));

export interface DimGeometry {
  /** Line segments to draw: extension lines and the dimension line. */
  lines: [Point, Point][];
  /** Arrow heads: the tip, and the unit direction the arrow points (towards the tip). */
  arrows: { tip: Point; dir: Point }[];
  /** Where the text is centred. */
  labelAt: Point;
}

/**
 * Linear: the dimension line runs parallel to the measuring axis, `offsetMm` beyond the points on the normal side
 * (normal = axis rotated 90 degrees counter-clockwise: up for horizontal, left for vertical). Radial: through the
 * centre (diameter) or from the centre (radius) to the circle at `angleRad`.
 */
export function dimGeometry(d: Dimension): DimGeometry {
  if (d.kind === "radial") {
    const u = { x: Math.cos(d.angleRad), y: Math.sin(d.angleRad) };
    const tip = add(d.center, u, d.radiusMm);
    if (d.diameter) {
      const opp = add(d.center, u, -d.radiusMm);
      return { lines: [[opp, tip]], arrows: [{ tip, dir: u }, { tip: opp, dir: { x: -u.x, y: -u.y } }], labelAt: d.center };
    }
    return { lines: [[d.center, tip]], arrows: [{ tip, dir: u }], labelAt: add(d.center, u, d.radiusMm / 2) };
  }
  const u = linearAxis(d);
  const n = { x: -u.y, y: u.x };
  const c = Math.max(dot(d.a, n), dot(d.b, n)) + d.offsetMm; // the dimension line is the set of points with p . n = c
  const p1 = add(d.a, n, c - dot(d.a, n));
  const p2 = add(d.b, n, c - dot(d.b, n));
  const ext = (from: Point, to: Point): [Point, Point] => {
    const l = dist(from, to);
    if (l < 1e-9) return [from, to];
    const dir = { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
    return [from, add(to, dir, 1.5)]; // extension lines overshoot the dimension line a little
  };
  const sign = dot({ x: p2.x - p1.x, y: p2.y - p1.y }, u) >= 0 ? 1 : -1;
  const toward = { x: u.x * sign, y: u.y * sign };
  return {
    lines: [ext(d.a, p1), ext(d.b, p2), [p1, p2]],
    arrows: [{ tip: p1, dir: { x: -toward.x, y: -toward.y } }, { tip: p2, dir: toward }],
    labelAt: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
  };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

/** How far `p` is from the dimension's drawing (lines or label), for picking. */
export function distToDim(d: Dimension, p: Point): number {
  const g = dimGeometry(d);
  return Math.min(dist(p, g.labelAt), ...g.lines.map(([a, b]) => distToSegment(p, a, b)));
}

export function pickDimension(dims: Dimension[], p: Point, tolMm: number): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const d of dims) {
    const k = distToDim(d, p);
    if (k <= tolMm && (!best || k < best.d)) best = { id: d.id, d: k };
  }
  return best?.id;
}

/** The circle or arc nearest `p` on a placed path, as a radial dimension, or null if the path has none near `p`. */
export function radialFromPath(path: Path, p: Point, tolMm: number, diameter: boolean, id: string): RadialDim | null {
  let cur = path.start;
  let best: { c: Point; r: number; d: number } | null = null;
  for (const s of path.segs) {
    if (s.t === "a") {
      const r = dist(cur, s.c);
      const sweep = arcSweep(s.c, cur, s.to, s.ccw);
      const ang = Math.atan2(p.y - s.c.y, p.x - s.c.x);
      const a0 = Math.atan2(cur.y - s.c.y, cur.x - s.c.x);
      const rel = s.ccw ? (((ang - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : (((a0 - ang) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const on = rel <= Math.abs(sweep) + 1e-6;
      const d = on ? Math.abs(dist(p, s.c) - r) : Math.min(dist(p, cur), dist(p, s.to));
      if (d <= tolMm && (!best || d < best.d)) best = { c: s.c, r, d };
    }
    cur = s.to;
  }
  if (!best) return null;
  return { id, kind: "radial", center: best.c, radiusMm: best.r, angleRad: Math.atan2(p.y - best.c.y, p.x - best.c.x), diameter };
}

/** Width and height dimensions for a box: width under it, height to its right. */
export function boxDimensions(b: { minX: number; minY: number; maxX: number; maxY: number }, nextId: () => string, offsetMm = 8): Dimension[] {
  const out: Dimension[] = [];
  if (b.maxX - b.minX > 1e-6) out.push({ id: nextId(), kind: "linear", axis: "horizontal", a: { x: b.minX, y: b.minY }, b: { x: b.maxX, y: b.minY }, offsetMm: -offsetMm });
  if (b.maxY - b.minY > 1e-6) out.push({ id: nextId(), kind: "linear", axis: "vertical", a: { x: b.maxX, y: b.minY }, b: { x: b.maxX, y: b.maxY }, offsetMm: -offsetMm });
  return out;
}

