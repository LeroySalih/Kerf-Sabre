// Corner radius (fillet) and chamfer for straight-line corners. Pure; bed space, mm.
// A rounded corner is a true arc tangent to both edges. Arcs/curves are left alone: only line-line corners round.
import type { Point } from "./coords";
import { explicit } from "./trim";
import type { Path, Seg } from "./geometry";

export type CornerMode = "radius" | "chamfer";

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: Point): Point => { const l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l }; };
const COS_FLAT = Math.cos((1 * Math.PI) / 180);

/** Start points of each segment (explicit closed paths already return to their start). */
const startsOf = (p: Path): Point[] => p.segs.map((_, i) => (i === 0 ? p.start : p.segs[i - 1]!.to));

/**
 * Indices of the vertices that can be rounded. Vertex k sits at the start of segs[k] (between segs[k-1] and segs[k]);
 * for closed paths vertex 0 is the path start. Only corners where two LINE segments meet at a real angle qualify.
 */
export function cornerVertices(path: Path): number[] {
  const p = explicit(path);
  const n = p.segs.length;
  const starts = startsOf(p);
  const out: number[] = [];
  for (let k = p.closed ? 0 : 1; k < n; k++) {
    const prev = (k - 1 + n) % n;
    const a = p.segs[prev]!, b = p.segs[k]!;
    if (a.t !== "l" || b.t !== "l") continue;
    const u = sub(starts[prev]!, starts[k]!), w = sub(b.to, starts[k]!);
    if (Math.hypot(u.x, u.y) < 1e-9 || Math.hypot(w.x, w.y) < 1e-9) continue;
    const cosPhi = (u.x * w.x + u.y * w.y) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y));
    if (cosPhi < -COS_FLAT || cosPhi > COS_FLAT) continue; // straight through, or a fold back onto itself
    out.push(k);
  }
  return out;
}

/** Vertex of `path` nearest to `p` within `tolMm`, among the roundable corners. */
export function findCorner(path: Path, p: Point, tolMm: number): number | null {
  const q = explicit(path);
  const starts = startsOf(q);
  let best: { k: number; d: number } | null = null;
  for (const k of cornerVertices(path)) {
    const d = dist(starts[k]!, p);
    if (d <= tolMm && (!best || d < best.d)) best = { k, d };
  }
  return best ? best.k : null;
}

export interface FilletResult {
  path: Path;
  /** Number of corners rounded. */
  corners: number;
  /** True if any corner had to use less than the requested size to fit its edges. */
  clamped: boolean;
}

/**
 * Round (or chamfer) the given vertices. `size` is the radius, or the setback along each edge for a chamfer.
 * Each corner may use at most half of each adjoining edge, except at the free ends of an open path (all of it).
 */
export function filletVertices(path: Path, vertices: number[], size: number, mode: CornerMode): FilletResult {
  const src = explicit(path);
  const n = src.segs.length;
  const starts = startsOf(src);
  const lens = src.segs.map((s, i) => (s.t === "l" ? dist(starts[i]!, s.to) : 0));
  const segs: Seg[] = src.segs.map((s) => ({ ...s }));
  let start = src.start;
  let clamped = false;
  let corners = 0;

  // Highest vertex first, so inserted segments never shift an index still to be processed; the path-start vertex last.
  const wanted = [...new Set(vertices)].filter((k) => k >= 0 && k < n);
  const desc = wanted.filter((k) => k !== 0).sort((a, b) => b - a).concat(wanted.includes(0) ? [0] : []);

  for (const k of desc) {
    const prev = (k - 1 + n) % n;
    const V = starts[k]!;
    const a = src.segs[prev]!, b = src.segs[k]!;
    if (a.t !== "l" || b.t !== "l") continue;
    const u = unit(sub(starts[prev]!, V)), w = unit(sub(b.to, V));
    const cosPhi = u.x * w.x + u.y * w.y;
    if (cosPhi < -COS_FLAT || cosPhi > COS_FLAT) continue;
    const phi = Math.acos(cosPhi); // interior angle at the corner
    const half = Math.tan(phi / 2);
    // setback along each edge
    let t = mode === "radius" ? size / half : size;
    const room = (segIdx: number, isPrevSide: boolean): number => {
      const freeEnd = !src.closed && (isPrevSide ? segIdx === 0 : segIdx === n - 1);
      return freeEnd ? lens[segIdx]! : lens[segIdx]! / 2;
    };
    const tmax = Math.min(room(prev, true), room(k, false));
    if (t > tmax + 1e-9) { t = tmax; clamped = true; }
    if (!(t > 1e-9)) continue;
    const T1 = { x: V.x + u.x * t, y: V.y + u.y * t };
    const T2 = { x: V.x + w.x * t, y: V.y + w.y * t };
    let corner: Seg;
    if (mode === "chamfer") corner = { t: "l", to: T2 };
    else {
      const r = t * half;
      const bis = unit({ x: u.x + w.x, y: u.y + w.y });
      const C = { x: V.x + bis.x * (r / Math.sin(phi / 2)), y: V.y + bis.y * (r / Math.sin(phi / 2)) };
      const d1 = { x: -u.x, y: -u.y }; // direction of travel into the corner
      corner = { t: "a", c: C, to: T2, ccw: d1.x * w.y - d1.y * w.x > 0 };
    }
    // Shorten the incoming edge to T1, add the corner, and start the outgoing edge at T2. Corners at higher indices
    // were inserted earlier and only shifted the segments after them, so for the path-start corner the incoming edge
    // is simply the last segment.
    (segs[k === 0 ? segs.length - 1 : k - 1] as { to: Point }).to = T1;
    if (k === 0) { segs.push(corner); start = T2; } else segs.splice(k, 0, corner);
    corners++;
  }
  return { path: { start, segs, closed: src.closed }, corners, clamped };
}

/** Round (or chamfer) every roundable corner. */
export function filletAll(path: Path, size: number, mode: CornerMode): FilletResult {
  return filletVertices(path, cornerVertices(path), size, mode);
}

/** The roundable corner nearest to `p` across several paths (bed space), within `tolMm`. */
export function nearestCorner<T extends { path: Path }>(items: T[], p: Point, tolMm: number): { item: T; vertex: number } | null {
  let best: { item: T; vertex: number; d: number } | null = null;
  for (const item of items) {
    const k = findCorner(item.path, p, tolMm);
    if (k === null) continue;
    const d = dist(startsOf(explicit(item.path))[k]!, p);
    if (!best || d < best.d) best = { item, vertex: k, d };
  }
  return best ? { item: best.item, vertex: best.vertex } : null;
}

/** Rectangle with rounded corners (true arcs), at the origin. The radius is limited to half the shorter side. */
export function roundedRectangle(w: number, h: number, r: number): Path {
  const base: Path = { start: { x: 0, y: 0 }, segs: [{ t: "l", to: { x: w, y: 0 } }, { t: "l", to: { x: w, y: h } }, { t: "l", to: { x: 0, y: h } }], closed: true };
  const radius = Math.min(Math.max(r, 0), Math.min(w, h) / 2);
  return radius < 1e-9 ? base : filletAll(base, radius, "radius").path;
}
