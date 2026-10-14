// Box net generator: the flat pattern for an open-topped five-sided box (base + four walls) that folds up from one
// sheet. Pure: returns shapes in design space (mm, Y-up); the caller places them. One closed Cut outline, plus Score
// lines for every fold. Layout (the base's lower-left corner is the origin):
//
//            back
//    left    base    right      front is below the base, back is above it, left/right are beside it.
//            front
//
// Optional flanges are tabs on the left and right walls' edges next to the front and back walls: each folds in and
// lies against the inside of the neighbouring wall. Optional slots add a tongue on each flange tip and a slit in the
// front/back wall for it to pass through, so the box locks without glue (slots need flanges).
import type { Point } from "./coords";
import { polylinePath, rectangle, translation, transformPath, type Path } from "./geometry";
import type { TestItem } from "./testgrid";

export interface BoxNetParams {
  widthMm: number; // X, along the front and back walls
  depthMm: number; // Y, along the left and right walls
  heightMm: number; // wall height
  thicknessMm: number; // material thickness: sets the slit width and the tongue length
  flanges: boolean;
  flangeMm: number; // how far a flange reaches in (its width)
  slots: boolean; // tongues on the flanges and slits in the front/back walls (needs flanges)
}

/** The tapered, tongued shape of a flange along its edge, derived once so the outline, scores and slits agree. */
export function flangeSizes(p: BoxNetParams): { taper: number; tongueWidth: number; tongueLength: number; slitLength: number } {
  const edge = p.heightMm; // a flange sits on a wall edge that is as long as the box is tall
  const taper = Math.min(p.flangeMm * 0.6, edge / 4);
  const tongueWidth = Math.max(2, Math.min(edge - 2 * taper - 2, edge * 0.5));
  return { taper, tongueWidth, tongueLength: Math.max(3, p.thicknessMm * 2), slitLength: tongueWidth + 1 };
}

export function validateBoxNet(p: BoxNetParams): string | null {
  if (![p.widthMm, p.depthMm, p.heightMm].every((n) => n >= 10)) return "Width, depth and height must each be at least 10 mm.";
  if (!(p.thicknessMm > 0) || p.thicknessMm > 20) return "Material thickness must be above 0 and at most 20 mm.";
  if (p.flanges) {
    if (!(p.flangeMm >= 3)) return "Flanges need to be at least 3 mm wide.";
    if (p.flangeMm > p.widthMm / 2 - 1) return "Flanges are too wide: two of them must fit along the front wall.";
    if (p.flangeMm > p.depthMm) return "Flanges are too wide for the side walls.";
    if (p.slots) {
      if (p.flangeMm + p.thicknessMm + 1 > p.widthMm / 2) return "The slots would overlap each other. Make the box wider or the flanges narrower.";
    }
  }
  return null;
}

export function boxNet(p: BoxNetParams): TestItem[] {
  const { widthMm: W, depthMm: D, heightMm: H } = p;
  const useFlanges = p.flanges;
  const useSlots = p.flanges && p.slots;
  const F = p.flangeMm;
  const s = flangeSizes(p);
  const scores: Point[][] = [];
  const pt = (x: number, y: number): Point => ({ x, y });

  /** Perimeter points from a to b (in outline order) for a flange pushed out along the unit normal n. a and b only when there are no flanges. */
  const flange = (a: Point, b: Point, n: Point): Point[] => {
    if (!useFlanges) return [a, b];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const e = pt((b.x - a.x) / len, (b.y - a.y) / len);
    const at = (along: number, out: number): Point => pt(a.x + e.x * along + n.x * out, a.y + e.y * along + n.y * out);
    scores.push([a, b]); // the fold
    const pts = [a, at(s.taper, F)];
    if (useSlots) {
      const lo = (len - s.tongueWidth) / 2, hi = lo + s.tongueWidth;
      pts.push(at(lo, F), at(lo, F + s.tongueLength), at(hi, F + s.tongueLength), at(hi, F));
      scores.push([at(lo, F), at(hi, F)]); // the tongue bends outward here, at its slit
    }
    pts.push(at(len - s.taper, F), b);
    return pts;
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

  if (useSlots) {
    for (const cy of [-H / 2, D + H / 2]) {
      for (const x of [F, W - F]) {
        items.push({ path: transformPath(rectangle(p.thicknessMm, s.slitLength), translation(x - p.thicknessMm / 2, cy - s.slitLength / 2)), layer: "cut" });
      }
    }
  }
  // Base folds: the four edges of the base rectangle, then the flange and tongue folds collected above.
  const base: Point[][] = [[pt(0, 0), pt(W, 0)], [pt(W, 0), pt(W, D)], [pt(W, D), pt(0, D)], [pt(0, D), pt(0, 0)]];
  for (const line of [...base, ...scores]) items.push({ path: polylinePath(line, false)!, layer: "score" });
  return items;
}
