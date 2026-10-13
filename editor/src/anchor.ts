// LightBurn-style anchor: which of 9 points on the selection's bounding box the X/Y fields refer to.
// Bed space is Y-up, so "top" is the larger Y.
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { boundsOf, transformPath, type Bounds, type Matrix } from "./geometry";

export interface Anchor {
  col: 0 | 1 | 2; // left, centre, right
  row: 0 | 1 | 2; // top, middle, bottom
}

export const DEFAULT_ANCHOR: Anchor = { col: 0, row: 2 }; // bottom-left, matches the bed origin

export function anchorPoint(b: Bounds, a: Anchor): Point {
  return {
    x: b.minX + (a.col * (b.maxX - b.minX)) / 2,
    y: b.maxY - (a.row * (b.maxY - b.minY)) / 2,
  };
}

/** Combined bounds of the given objects in bed space, or null if none. */
export function selectionBounds(objects: DocObject[], ids: Iterable<number>): Bounds | null {
  const set = new Set(ids);
  const bs = objects.filter((o) => set.has(o.id)).map((o) => boundsOf(transformPath(o.path, o.matrix)));
  if (!bs.length) return null;
  return {
    minX: Math.min(...bs.map((b) => b.minX)), maxX: Math.max(...bs.map((b) => b.maxX)),
    minY: Math.min(...bs.map((b) => b.minY)), maxY: Math.max(...bs.map((b) => b.maxY)),
  };
}

/** Translation that puts the anchor at `target`. Pass only the axes you want to change. */
export function deltaToAnchor(b: Bounds, a: Anchor, target: Partial<Point>): Point {
  const p = anchorPoint(b, a);
  return { x: target.x === undefined ? 0 : target.x - p.x, y: target.y === undefined ? 0 : target.y - p.y };
}

export type Axis = "w" | "h";

/**
 * Matrix that resizes the selection to `size` along one axis, keeping the anchor point fixed.
 * With `lock` both axes scale by the same factor (arcs stay arcs). Returns null if the request
 * can't be met: non-positive size, or the selection has zero extent on that axis.
 */
export function scaleAboutAnchor(b: Bounds, a: Anchor, axis: Axis, size: number, lock: boolean): Matrix | null {
  const cur = axis === "w" ? b.maxX - b.minX : b.maxY - b.minY;
  if (!(size > 0) || !(cur > 1e-9)) return null;
  const f = size / cur;
  const sx = axis === "w" || lock ? f : 1;
  const sy = axis === "h" || lock ? f : 1;
  const p = anchorPoint(b, a);
  return [sx, 0, 0, sy, p.x - sx * p.x, p.y - sy * p.y];
}
