// Box net generator: the flat pattern for an open-topped five-sided box (base + four walls) that folds up from one
// sheet. Pure: returns shapes in design space (mm, Y-up); the caller places them. One closed Cut outline, plus Score
// lines for every fold. Layout (the base's lower-left corner is the origin):
//
//            back
//    left    base    right      front is below the base, back is above it, left/right are beside it.
//            front
//
// Optional flanges are glue tabs on the left and right walls' edges next to the front and back walls: each folds in
// and is glued against the inside of the neighbouring wall.
import type { Point } from "./coords";
import { polylinePath } from "./geometry";
import type { TestItem } from "./testgrid";

export interface BoxNetParams {
  widthMm: number; // X, along the front and back walls
  depthMm: number; // Y, along the left and right walls
  heightMm: number; // wall height
  flanges: boolean;
  flangeMm: number; // how far a glue flange reaches in (its width)
}

export function validateBoxNet(p: BoxNetParams): string | null {
  if (![p.widthMm, p.depthMm, p.heightMm].every((n) => n >= 10)) return "Width, depth and height must each be at least 10 mm.";
  if (p.flanges) {
    if (!(p.flangeMm >= 3)) return "Flanges need to be at least 3 mm wide.";
    if (p.flangeMm > p.widthMm / 2 - 1) return "Flanges are too wide: two of them must fit along the front wall.";
    if (p.flangeMm > p.depthMm) return "Flanges are too wide for the side walls.";
  }
  return null;
}

export function boxNet(p: BoxNetParams): TestItem[] {
  const { widthMm: W, depthMm: D, heightMm: H } = p;
  const F = p.flangeMm;
  const taper = Math.min(F * 0.6, H / 4); // slanted ends so the flange clears the neighbouring wall
  const folds: Point[][] = [];
  const pt = (x: number, y: number): Point => ({ x, y });

  /** Perimeter points from a to b (in outline order), with a glue flange pushed out along the unit normal n. */
  const flange = (a: Point, b: Point, n: Point): Point[] => {
    if (!p.flanges) return [a, b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const e = pt((b.x - a.x) / len, (b.y - a.y) / len);
    const at = (along: number, out: number): Point => pt(a.x + e.x * along + n.x * out, a.y + e.y * along + n.y * out);
    folds.push([a, b]);
    return [a, at(taper, F), at(len - taper, F), b];
  };

  // Outline, counter-clockwise from the front wall's lower-left corner.
  const outline: Point[] = [pt(0, -H), pt(W, -H), pt(W, 0)];
  outline.push(...flange(pt(W, 0), pt(W + H, 0), pt(0, -1)).slice(1)); // right wall, lower edge
  outline.push(pt(W + H, D));
  outline.push(...flange(pt(W + H, D), pt(W, D), pt(0, 1)).slice(1)); // right wall, upper edge
  outline.push(pt(W, D + H), pt(0, D + H), pt(0, D));
  outline.push(...flange(pt(0, D), pt(-H, D), pt(0, 1)).slice(1)); // left wall, upper edge
  outline.push(pt(-H, 0));
  outline.push(...flange(pt(-H, 0), pt(0, 0), pt(0, -1)).slice(1)); // left wall, lower edge; the outline closes back to (0,-H)

  const items: TestItem[] = [{ path: polylinePath(outline, true)!, layer: "cut" }];
  // Base folds: the four edges of the base rectangle, then the flange folds.
  const base: Point[][] = [[pt(0, 0), pt(W, 0)], [pt(W, 0), pt(W, D)], [pt(W, D), pt(0, D)], [pt(0, D), pt(0, 0)]];
  for (const line of [...base, ...folds]) items.push({ path: polylinePath(line, false)!, layer: "score" });
  return items;
}
