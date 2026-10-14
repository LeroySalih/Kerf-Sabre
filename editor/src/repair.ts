// Repair tools: join loose segments into paths, close, explode, and node editing. Pure; bed space, mm.
import type { Point } from "./coords";
import { arcToCubics, type Path, type Seg } from "./geometry";
import { explicit } from "./trim";

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The point a path ends on. */
export const endOf = (p: Path): Point => (p.segs.length ? p.segs[p.segs.length - 1]!.to : p.start);

/** The same path travelled the other way round (arcs flip direction, curve handles swap). */
export function reversePath(p: Path): Path {
  const pts = [p.start, ...p.segs.map((s) => s.to)];
  const segs: Seg[] = [];
  for (let i = p.segs.length - 1; i >= 0; i--) {
    const s = p.segs[i]!, to = pts[i]!;
    if (s.t === "l") segs.push({ t: "l", to });
    else if (s.t === "a") segs.push({ t: "a", c: s.c, to, ccw: !s.ccw });
    else segs.push({ t: "c", c1: s.c2, c2: s.c1, to });
  }
  return { start: endOf(p), segs, closed: p.closed };
}

export interface JoinResult {
  paths: Path[];
  /** How many times one path was attached to another. */
  merges: number;
  /** How many of the results are now closed loops that were open before. */
  newlyClosed: number;
}

/**
 * Chain open paths whose ends meet (within `tolMm`) into longer paths, closing any that come back to where they began.
 * Closed paths pass through unchanged. Where three or more ends meet, the nearest is taken.
 */
export function joinPaths(paths: Path[], tolMm: number): JoinResult {
  const open = paths.filter((p) => !p.closed && p.segs.length > 0);
  const out: Path[] = paths.filter((p) => p.closed || p.segs.length === 0);
  const alive = open.map(() => true);

  // bucket the ends so each lookup only looks at its neighbours
  const cell = Math.max(tolMm * 2, 1e-3);
  const key = (x: number, y: number) => `${Math.round(x / cell)},${Math.round(y / cell)}`;
  type End = { i: number; atStart: boolean };
  const grid = new Map<string, End[]>();
  const put = (pt: Point, e: End) => { const k = key(pt.x, pt.y); (grid.get(k) ?? grid.set(k, []).get(k)!).push(e); };
  open.forEach((p, i) => { put(p.start, { i, atStart: true }); put(endOf(p), { i, atStart: false }); });

  const nearest = (pt: Point): End | null => {
    let best: { e: End; d: number } | null = null;
    const cx = Math.round(pt.x / cell), cy = Math.round(pt.y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const e of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (!alive[e.i]) continue;
          const d = dist(pt, e.atStart ? open[e.i]!.start : endOf(open[e.i]!));
          if (d <= tolMm && (!best || d < best.d)) best = { e, d };
        }
    return best ? best.e : null;
  };

  let merges = 0;
  let newlyClosed = 0;
  const extend = (chain: Path): Path => {
    for (;;) {
      const hit = nearest(endOf(chain));
      if (!hit) return chain;
      alive[hit.i] = false;
      const next = hit.atStart ? open[hit.i]! : reversePath(open[hit.i]!);
      chain = { start: chain.start, segs: [...chain.segs, ...next.segs], closed: false };
      merges++;
    }
  };

  for (let i = 0; i < open.length; i++) {
    if (!alive[i]) continue;
    alive[i] = false;
    let chain: Path = open[i]!;
    chain = extend(chain);
    chain = reversePath(extend(reversePath(chain))); // then grow the other end, and restore the direction
    if (chain.segs.length >= 2 && dist(chain.start, endOf(chain)) <= tolMm) {
      const segs = chain.segs.slice();
      const last = segs[segs.length - 1]!;
      segs[segs.length - 1] = last.t === "l" ? { t: "l", to: chain.start } : last.t === "a" ? { ...last, to: chain.start } : { ...last, to: chain.start };
      chain = { start: chain.start, segs, closed: true };
      newlyClosed++;
    }
    out.push(chain);
  }
  return { paths: out, merges, newlyClosed };
}

/** Close an open path: snap it shut if the ends are within `tolMm`, otherwise add a straight closing edge. */
export function closePath(p: Path, tolMm: number): Path {
  if (p.closed) return p;
  if (p.segs.length >= 2 && dist(p.start, endOf(p)) <= tolMm) {
    const segs = p.segs.slice();
    const last = segs[segs.length - 1]!;
    segs[segs.length - 1] = last.t === "l" ? { t: "l", to: p.start } : last.t === "a" ? { ...last, to: p.start } : { ...last, to: p.start };
    return { start: p.start, segs, closed: true };
  }
  return { start: p.start, segs: p.segs, closed: true }; // the closing edge is implicit
}

/** One open path per segment. */
export function explodePath(p: Path): Path[] {
  const q = explicit(p);
  let cur = q.start;
  return q.segs.map((s) => {
    const piece: Path = { start: cur, segs: [s], closed: false };
    cur = s.to;
    return piece;
  });
}

// ---- node editing ----

/** The editable vertices of a path, in order. For closed paths the duplicate end point is not listed twice. */
export function nodePoints(p: Path): Point[] {
  const q = explicit(p);
  const pts = [q.start, ...q.segs.map((s) => s.to)];
  return q.closed ? pts.slice(0, -1) : pts;
}

/** Replace arcs by cubic curves so their end points can move freely. Lines and curves are untouched. */
function curvesOnly(p: Path): Path {
  let cur = p.start;
  const segs: Seg[] = [];
  for (const s of p.segs) {
    if (s.t === "a") segs.push(...arcToCubics(s.c, cur, s.to, s.ccw));
    else segs.push(s);
    cur = s.to;
  }
  return { ...p, segs };
}

/** Move node `index` to `to`. Curve handles move with it. Neighbouring arcs become curves. */
export function moveNode(path: Path, index: number, to: Point): Path {
  const q = curvesOnly(explicit(path));
  const n = q.segs.length;
  const dx = to.x - nodePoints(q)[index]!.x, dy = to.y - nodePoints(q)[index]!.y;
  const shift = (pt: Point): Point => ({ x: pt.x + dx, y: pt.y + dy });
  const segs = q.segs.map((s) => ({ ...s })) as Seg[];
  let start = q.start;
  const into = index === 0 && q.closed ? n - 1 : index - 1; // the segment arriving at this node
  const out = index; // the segment leaving it
  if (index === 0) start = shift(q.start);
  if (into >= 0 && into < n) { const s = segs[into]!; segs[into] = s.t === "c" ? { t: "c", c1: s.c1, c2: shift(s.c2), to: shift(s.to) } : { ...s, to: shift(s.to) } as Seg; }
  if (out < n) { const s = segs[out]!; if (s.t === "c") segs[out] = { ...s, c1: shift(s.c1) }; }
  return { start, segs, closed: q.closed };
}

/** Split the segment `segIndex` at the point on it nearest `near`, adding a node. Lines and arcs split exactly; curves by de Casteljau. */
export function insertNode(path: Path, segIndex: number, near: Point): Path {
  const q = explicit(path);
  const starts = [q.start, ...q.segs.map((s) => s.to)];
  const s = q.segs[segIndex];
  if (!s) return path;
  const a = starts[segIndex]!;
  let first: Seg, second: Seg;
  if (s.t === "l") {
    const dx = s.to.x - a.x, dy = s.to.y - a.y;
    const t = Math.min(1, Math.max(0, ((near.x - a.x) * dx + (near.y - a.y) * dy) / (dx * dx + dy * dy)));
    const m = { x: a.x + dx * t, y: a.y + dy * t };
    first = { t: "l", to: m };
    second = { t: "l", to: s.to };
  } else if (s.t === "a") {
    const r = dist(a, s.c);
    const ang = Math.atan2(near.y - s.c.y, near.x - s.c.x);
    const m = { x: s.c.x + r * Math.cos(ang), y: s.c.y + r * Math.sin(ang) };
    first = { t: "a", c: s.c, to: m, ccw: s.ccw };
    second = { t: "a", c: s.c, to: s.to, ccw: s.ccw };
  } else {
    // nearest parameter by sampling, then split
    const at = (t: number): Point => {
      const u = 1 - t;
      return { x: u * u * u * a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x, y: u * u * u * a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y };
    };
    let bt = 0.5, bd = Infinity;
    for (let i = 1; i < 100; i++) { const d = dist(at(i / 100), near); if (d < bd) { bd = d; bt = i / 100; } }
    const lerp = (p: Point, r: Point, t: number): Point => ({ x: p.x + (r.x - p.x) * t, y: p.y + (r.y - p.y) * t });
    const q0 = lerp(a, s.c1, bt), q1 = lerp(s.c1, s.c2, bt), q2 = lerp(s.c2, s.to, bt);
    const r0 = lerp(q0, q1, bt), r1 = lerp(q1, q2, bt);
    const m = lerp(r0, r1, bt);
    first = { t: "c", c1: q0, c2: r0, to: m };
    second = { t: "c", c1: r1, c2: q2, to: s.to };
  }
  const segs = q.segs.slice();
  segs.splice(segIndex, 1, first, second);
  return { start: q.start, segs, closed: q.closed };
}

/** Remove node `index`, joining its neighbours with a straight line. Returns null if too little would remain. */
export function deleteNode(path: Path, index: number): Path | null {
  const q = explicit(path);
  const n = q.segs.length;
  const minSegs = q.closed ? 3 : 1;
  if (n - 1 < minSegs) return null;
  if (!q.closed) {
    if (index === 0) return { start: q.segs[0]!.to, segs: q.segs.slice(1), closed: false }; // drop the first edge
    if (index === n) return { start: q.start, segs: q.segs.slice(0, -1), closed: false };
    const segs = q.segs.slice();
    segs.splice(index - 1, 2, { t: "l", to: q.segs[index]!.to });
    return { start: q.start, segs, closed: false };
  }
  if (index === 0) {
    // the start node: the new start is the next node, and the last edge now ends there
    const segs = q.segs.slice(1, -1);
    segs.push({ t: "l", to: q.segs[0]!.to });
    return { start: q.segs[0]!.to, segs, closed: true };
  }
  const segs = q.segs.slice();
  segs.splice(index - 1, 2, { t: "l", to: q.segs[index]!.to });
  return { start: q.start, segs, closed: true };
}
