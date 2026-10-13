// Snapping: endpoints, midpoints, arc centres, intersections and the 1 cm grid. Pure; bed space, mm.
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { arcMid, flatten, transformPath, type Seg } from "./geometry";
import { distToPrim, explicit, intersect, primOf, startsOf, type Prim } from "./trim";

export type SnapKind = "endpoint" | "intersection" | "midpoint" | "centre" | "grid";

export interface Snap { point: Point; kind: SnapKind; dist: number }

export const GRID_MM = 10;
const RANK: Record<SnapKind, number> = { endpoint: 0, intersection: 1, midpoint: 2, centre: 3, grid: 4 };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export interface SnapOptions {
  grid?: boolean;
  /** Objects to ignore, e.g. the ones being dragged. */
  exclude?: ReadonlySet<number>;
}

function midOf(start: Point, s: Seg): Point {
  if (s.t === "l") return { x: (start.x + s.to.x) / 2, y: (start.y + s.to.y) / 2 };
  if (s.t === "a") return arcMid(s.c, start, s.to, s.ccw);
  const pts = flatten({ start, segs: [s], closed: false });
  return pts[Math.floor(pts.length / 2)]!;
}

/** Best snap within `tolMm` of `p`, or null. Nearest wins; ties go endpoint > intersection > midpoint > centre. Grid is the fallback. */
export function snapTo(objects: DocObject[], p: Point, tolMm: number, opts: SnapOptions = {}): Snap | null {
  const found: Snap[] = [];
  const add = (point: Point, kind: SnapKind) => {
    const d = dist(point, p);
    if (d <= tolMm) found.push({ point, kind, dist: d });
  };
  const near: Prim[] = []; // only segments close to the cursor can produce a nearby intersection

  for (const o of objects) {
    if (opts.exclude?.has(o.id)) continue;
    const path = explicit(transformPath(o.path, o.matrix));
    const starts = startsOf(path);
    path.segs.forEach((s, i) => {
      add(starts[i]!, "endpoint");
      add(s.to, "endpoint");
      add(midOf(starts[i]!, s), "midpoint");
      if (s.t === "a") add(s.c, "centre");
      for (const prim of primOf(starts[i]!, s)) if (distToPrim(p, prim).d <= tolMm) near.push(prim);
    });
  }
  for (let i = 0; i < near.length; i++)
    for (let j = i + 1; j < near.length; j++) for (const h of intersect(near[i]!, near[j]!)) add(h.pt, "intersection");

  if (found.length) return found.sort((a, b) => (Math.abs(a.dist - b.dist) < 1e-9 ? RANK[a.kind] - RANK[b.kind] : a.dist - b.dist))[0]!;

  if (opts.grid) {
    const g = { x: Math.round(p.x / GRID_MM) * GRID_MM, y: Math.round(p.y / GRID_MM) * GRID_MM };
    const d = dist(g, p);
    if (d <= tolMm) return { point: g, kind: "grid", dist: d };
  }
  return null;
}
