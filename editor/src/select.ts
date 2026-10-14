// Box selection, LightBurn style: drag left->right = window (must enclose the shape),
// drag right->left = crossing (may touch the shape's outline).
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { boundsOf, flatten, transformPath } from "./geometry";

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export type BoxMode = "window" | "crossing";

export function boxMode(a: Point, b: Point): BoxMode {
  return b.x >= a.x ? "window" : "crossing";
}

export function rectOf(a: Point, b: Point): Rect {
  return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
}

const inside = (r: Rect, p: Point) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function onSegment(p: Point, q: Point, r: Point): boolean {
  return Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSegment(p3, p1, p4)) || (d2 === 0 && onSegment(p3, p2, p4)) ||
    (d3 === 0 && onSegment(p1, p3, p2)) || (d4 === 0 && onSegment(p1, p4, p2));
}

/** True if the segment a-b has a point inside or on the rectangle. */
function segmentTouchesRect(r: Rect, a: Point, b: Point): boolean {
  if (inside(r, a) || inside(r, b)) return true;
  const c = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
  return c.some((p, i) => segmentsIntersect(a, b, p, c[(i + 1) % 4]!));
}

/** Ids of objects selected by dragging a box from `a` to `b` (bed space, mm). */
export function boxSelect(objects: DocObject[], a: Point, b: Point): number[] {
  const r = rectOf(a, b);
  const mode = boxMode(a, b);
  const ids: number[] = [];
  for (const o of objects) {
    const path = transformPath(o.path, o.matrix);
    if (mode === "window") {
      const b = boundsOf(path);
      if (b.minX >= r.minX && b.maxX <= r.maxX && b.minY >= r.minY && b.maxY <= r.maxY) ids.push(o.id);
    } else {
      const pts = flatten(path);
      const pairs = pts.slice(1).map((p, i) => [pts[i]!, p] as const);
      if (path.closed) pairs.push([pts[pts.length - 1]!, pts[0]!]);
      if (pairs.some(([p, q]) => segmentTouchesRect(r, p, q)) || (pairs.length === 0 && inside(r, pts[0]!))) ids.push(o.id);
    }
  }
  return ids;
}
