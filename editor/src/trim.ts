// Trim: click a line or arc and remove the part between the nearest boundaries on either side.
// Boundaries are intersections with other geometry, sharp corners, and (for open paths) the free ends.
// Everything here works in bed space; the caller replaces the object with the kept paths.
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { arcSweep, flatten, transformPath, type Path, type Seg } from "./geometry";

const EPS = 1e-9;
const TAU = Math.PI * 2;
const mod = (a: number, m: number) => ((a % m) + m) % m;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// ---- primitives and intersections ----

export interface LinePrim { kind: "l"; a: Point; b: Point }
export interface ArcPrim { kind: "a"; c: Point; r: number; a0: number; sweep: number }
export type Prim = LinePrim | ArcPrim;

interface Hit { tp: number; tq: number; pt: Point }

function arcFrac(arc: ArcPrim, pt: Point): number {
  const ang = Math.atan2(pt.y - arc.c.y, pt.x - arc.c.x);
  const delta = arc.sweep >= 0 ? mod(ang - arc.a0, TAU) : mod(arc.a0 - ang, TAU);
  return delta / Math.abs(arc.sweep);
}
const arcPoint = (arc: ArcPrim, t: number): Point => ({
  x: arc.c.x + arc.r * Math.cos(arc.a0 + arc.sweep * t),
  y: arc.c.y + arc.r * Math.sin(arc.a0 + arc.sweep * t),
});
// A point just before the arc start can read as frac ~ 1 (wraps); treat that as 0.
const fracOk = (f: number) => f <= 1 + 1e-9 || f >= 1 - 1e-9 + (TAU / 1e9);

function lineLine(p: LinePrim, q: LinePrim): Hit[] {
  const r = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }, s = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
  const d = r.x * s.y - r.y * s.x;
  if (Math.abs(d) < 1e-12) return []; // parallel or collinear: ignore
  const qp = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
  const t = (qp.x * s.y - qp.y * s.x) / d, u = (qp.x * r.y - qp.y * r.x) / d;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return [];
  const tc = Math.min(1, Math.max(0, t));
  return [{ tp: tc, tq: Math.min(1, Math.max(0, u)), pt: lerp(p.a, p.b, tc) }];
}

function lineArc(p: LinePrim, q: ArcPrim): Hit[] {
  const d = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  const f = { x: p.a.x - q.c.x, y: p.a.y - q.c.y };
  const A = d.x * d.x + d.y * d.y;
  if (A < 1e-18 || Math.abs(q.sweep) < 1e-12) return [];
  const B = 2 * (f.x * d.x + f.y * d.y), C = f.x * f.x + f.y * f.y - q.r * q.r;
  let disc = B * B - 4 * A * C;
  if (disc < -1e-9 * Math.max(1, B * B)) return [];
  disc = Math.max(0, disc);
  const roots = disc === 0 ? [-B / (2 * A)] : [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)];
  const out: Hit[] = [];
  for (const t of roots) {
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const tc = Math.min(1, Math.max(0, t));
    const pt = lerp(p.a, p.b, tc);
    const fr = arcFrac(q, pt);
    if (fr <= 1 + 1e-9) out.push({ tp: tc, tq: Math.min(1, fr), pt });
    else if (TAU - fr * Math.abs(q.sweep) < 1e-9) out.push({ tp: tc, tq: 0, pt }); // wrapped onto the start
  }
  return out;
}

function arcArc(p: ArcPrim, q: ArcPrim): Hit[] {
  const dx = q.c.x - p.c.x, dy = q.c.y - p.c.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return [];
  if (d > p.r + q.r + 1e-9 || d < Math.abs(p.r - q.r) - 1e-9) return [];
  const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
  const m = { x: p.c.x + (a * dx) / d, y: p.c.y + (a * dy) / d };
  const cands = h < 1e-9 ? [m] : [{ x: m.x + (h * -dy) / d, y: m.y + (h * dx) / d }, { x: m.x - (h * -dy) / d, y: m.y - (h * dx) / d }];
  const out: Hit[] = [];
  for (const pt of cands) {
    const fp = arcFrac(p, pt), fq = arcFrac(q, pt);
    const okp = fp <= 1 + 1e-9 || TAU - fp * Math.abs(p.sweep) < 1e-9;
    const okq = fq <= 1 + 1e-9 || TAU - fq * Math.abs(q.sweep) < 1e-9;
    if (okp && okq) out.push({ tp: Math.min(1, fp > 1 + 1e-9 ? 0 : fp), tq: Math.min(1, fq > 1 + 1e-9 ? 0 : fq), pt });
  }
  return out;
}

export function intersect(p: Prim, q: Prim): Hit[] {
  if (p.kind === "l" && q.kind === "l") return lineLine(p, q);
  if (p.kind === "l" && q.kind === "a") return lineArc(p, q);
  if (p.kind === "a" && q.kind === "l") return lineArc(q, p).map((h) => ({ tp: h.tq, tq: h.tp, pt: h.pt }));
  return arcArc(p as ArcPrim, q as ArcPrim);
}

// ---- path helpers ----

/** Closed paths get an explicit closing segment so every closed path loops through its segments. */
export function explicit(path: Path): Path {
  if (!path.closed || !path.segs.length) return path;
  const last = path.segs[path.segs.length - 1]!.to;
  if (dist(last, path.start) < 1e-9) return path;
  return { ...path, segs: [...path.segs, { t: "l", to: path.start }] };
}

export function startsOf(path: Path): Point[] {
  return path.segs.map((_, i) => (i === 0 ? path.start : path.segs[i - 1]!.to));
}

export function primOf(start: Point, s: Seg): Prim[] {
  if (s.t === "l") return [{ kind: "l", a: start, b: s.to }];
  if (s.t === "a") {
    const r = dist(start, s.c);
    return [{ kind: "a", c: s.c, r, a0: Math.atan2(start.y - s.c.y, start.x - s.c.x), sweep: arcSweep(s.c, start, s.to, s.ccw) }];
  }
  const pts = flatten({ start, segs: [s], closed: false }, 0.02); // cubics only act as cutters
  return pts.slice(1).map((b, i) => ({ kind: "l", a: pts[i]!, b }));
}

function subSeg(start: Point, s: Seg, a: number, b: number): { from: Point; seg: Seg } {
  if (s.t === "l") return { from: a === 0 ? start : lerp(start, s.to, a), seg: { t: "l", to: b === 1 ? s.to : lerp(start, s.to, b) } };
  if (s.t === "a") {
    const prim = primOf(start, s)[0] as ArcPrim;
    return {
      from: a === 0 ? start : arcPoint(prim, a),
      seg: { t: "a", c: s.c, to: b === 1 ? s.to : arcPoint(prim, b), ccw: s.ccw },
    };
  }
  // cubic: de Casteljau at b, then at a/b
  const split = (p0: Point, p1: Point, p2: Point, p3: Point, t: number) => {
    const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
    const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
    const m = lerp(r0, r1, t);
    return { left: [p0, q0, r0, m] as const, right: [m, r1, q2, p3] as const };
  };
  let [p0, p1, p2, p3] = [start, s.c1, s.c2, s.to] as [Point, Point, Point, Point];
  if (b < 1) [p0, p1, p2, p3] = split(p0, p1, p2, p3, b).left as unknown as [Point, Point, Point, Point];
  if (a > 0) [p0, p1, p2, p3] = split(p0, p1, p2, p3, a / b).right as unknown as [Point, Point, Point, Point];
  return { from: p0, seg: { t: "c", c1: p1, c2: p2, to: p3 } };
}

/** Chain from position u0 to u1 (segment index + fraction; may exceed n on closed paths). */
function extract(path: Path, u0: number, u1: number): Path | null {
  const n = path.segs.length;
  const starts = startsOf(path);
  const segs: Seg[] = [];
  let first: Point | null = null;
  for (let k = Math.floor(u0 + 1e-12); k < Math.ceil(u1 - 1e-12); k++) {
    const a = Math.max(u0, k) - k, b = Math.min(u1, k + 1) - k;
    if (b - a < 1e-7) continue;
    const idx = k % n;
    const { from, seg } = subSeg(starts[idx]!, path.segs[idx]!, a, b);
    if (!first) first = from;
    segs.push(seg);
  }
  return first && segs.length ? { start: first, segs, closed: false } : null;
}

function unit(v: Point): Point | null {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? null : { x: v.x / l, y: v.y / l };
}
function tangents(start: Point, s: Seg): { in: Point | null; out: Point | null } {
  if (s.t === "l") { const t = unit({ x: s.to.x - start.x, y: s.to.y - start.y }); return { in: t, out: t }; }
  if (s.t === "a") {
    const tan = (p: Point) => (s.ccw ? { x: -(p.y - s.c.y), y: p.x - s.c.x } : { x: p.y - s.c.y, y: -(p.x - s.c.x) });
    return { in: unit(tan(start)), out: unit(tan(s.to)) };
  }
  return {
    in: unit({ x: s.c1.x - start.x, y: s.c1.y - start.y }) ?? unit({ x: s.c2.x - start.x, y: s.c2.y - start.y }),
    out: unit({ x: s.to.x - s.c2.x, y: s.to.y - s.c2.y }) ?? unit({ x: s.to.x - s.c1.x, y: s.to.y - s.c1.y }),
  };
}

const COS_CORNER = Math.cos((1 * Math.PI) / 180);
function isCorner(prevStart: Point, prev: Seg, nextStart: Point, next: Seg): boolean {
  const a = tangents(prevStart, prev).out, b = tangents(nextStart, next).in;
  return !a || !b || a.x * b.x + a.y * b.y < COS_CORNER;
}

// ---- planning ----

export interface TrimPlan {
  objectId: number;
  /** Paths (bed space, open) that remain. Empty means the whole object goes. */
  keep: Path[];
  /** The part that will be removed, for preview. */
  removed: Path;
}

interface Placed { id: number; path: Path }

export function distToPrim(pt: Point, prim: Prim): { d: number; t: number } {
  if (prim.kind === "l") {
    const dx = prim.b.x - prim.a.x, dy = prim.b.y - prim.a.y, l2 = dx * dx + dy * dy;
    const t = l2 < 1e-18 ? 0 : Math.min(1, Math.max(0, ((pt.x - prim.a.x) * dx + (pt.y - prim.a.y) * dy) / l2));
    return { d: dist(pt, lerp(prim.a, prim.b, t)), t };
  }
  const fr = arcFrac(prim, pt);
  if (fr <= 1) return { d: Math.abs(dist(pt, prim.c) - prim.r), t: fr };
  const e0 = arcPoint(prim, 0), e1 = arcPoint(prim, 1);
  return dist(pt, e0) <= dist(pt, e1) ? { d: dist(pt, e0), t: 0 } : { d: dist(pt, e1), t: 1 };
}

/** Work out what clicking at `click` (bed mm) would trim. Null when there is nothing to trim there. */
export function planTrim(objects: DocObject[], click: Point, tolMm: number): TrimPlan | null {
  const placed: Placed[] = objects.map((o) => ({ id: o.id, path: explicit(transformPath(o.path, o.matrix)) }));

  // 1. nearest segment to the click
  let best: { pi: number; si: number; d: number; t: number } | null = null;
  placed.forEach((pl, pi) => {
    const starts = startsOf(pl.path);
    pl.path.segs.forEach((s, si) => {
      for (const prim of primOf(starts[si]!, s)) {
        const r = distToPrim(click, prim);
        if (r.d <= tolMm && (!best || r.d < best.d)) best = { pi, si, d: r.d, t: r.t };
      }
    });
  });
  if (!best) return null;
  const { pi, si } = best as { pi: number; si: number };
  const subject = placed[pi]!;
  const path = subject.path;
  if (path.segs[si]!.t === "c") return null; // trimming curves is not supported yet
  const n = path.segs.length;
  const starts = startsOf(path);

  // exact click position along the chosen segment (cubic-free: single prim)
  const clickT = distToPrim(click, primOf(starts[si]!, path.segs[si]!)[0]!).t;
  const uc = si + clickT;

  // 2. cutters: every segment of every object, tagged with owner
  const cutters: { pi: number; si: number; prim: Prim }[] = [];
  placed.forEach((pl, qi) => {
    const st = startsOf(pl.path);
    pl.path.segs.forEach((s, qs) => primOf(st[qs]!, s).forEach((prim) => cutters.push({ pi: qi, si: qs, prim })));
  });

  // 3. breakpoints along the subject path
  const bps: number[] = [];
  const adjacentShared = (i: number, j: number): Point[] => {
    const shared: Point[] = [];
    if ((i + 1) % n === j && (path.closed || i + 1 < n)) shared.push(path.segs[i]!.to);
    if ((j + 1) % n === i && (path.closed || j + 1 < n)) shared.push(path.segs[j]!.to);
    return shared;
  };
  path.segs.forEach((s, i) => {
    if (s.t === "c") return;
    const subj = primOf(starts[i]!, s)[0]!;
    for (const c of cutters) {
      if (c.pi === pi && c.si === i) continue;
      const skip = c.pi === pi ? adjacentShared(i, c.si) : [];
      for (const h of intersect(subj, c.prim)) {
        if (skip.some((v) => dist(v, h.pt) < 1e-6)) continue;
        bps.push(i + h.tp);
      }
    }
  });
  const vertexRange = path.closed ? [...Array(n).keys()] : [...Array(Math.max(0, n - 1)).keys()].map((k) => k + 1);
  for (const k of vertexRange) {
    const prev = (k - 1 + n) % n, next = k % n;
    if (isCorner(starts[prev]!, path.segs[prev]!, starts[next]!, path.segs[next]!)) bps.push(k);
  }

  // 4. nearest boundaries either side of the click
  let lo: number, hi: number;
  if (path.closed) {
    const sorted = bps.map((b) => mod(b, n)).sort((a, b) => a - b)
      .filter((b, i, all) => i === 0 || b - all[i - 1]! > 1e-7) // drop duplicates, keep exact values
      .filter((b, _, all) => b < n - 1e-7 || all[0]! > 1e-7); // a hit at the very end duplicates one at 0
    if (sorted.length < 2) return null; // nothing bounds a closed loop: refuse rather than delete it
    const below = sorted.filter((b) => b <= uc + 1e-9), above = sorted.filter((b) => b > uc + 1e-9);
    lo = below.length ? below[below.length - 1]! : sorted[sorted.length - 1]! - n;
    hi = above.length ? above[0]! : sorted[0]! + n;
  } else {
    const all = [0, n, ...bps.map((b) => Math.min(n, Math.max(0, b)))];
    lo = Math.max(...all.filter((b) => b <= uc + 1e-9));
    hi = Math.min(...all.filter((b) => b > uc + 1e-9));
  }

  const removed = extract(path, lo, hi);
  if (!removed) return null;
  const keep: Path[] = [];
  if (path.closed) {
    const around = extract(path, hi, lo + n);
    if (around) keep.push(around);
  } else {
    const a = extract(path, 0, lo), b = extract(path, hi, n);
    if (a) keep.push(a);
    if (b) keep.push(b);
  }
  return { objectId: subject.id, keep, removed };
}
