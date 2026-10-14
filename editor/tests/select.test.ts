import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { circle, line, rectangle, translation } from "../src/geometry";
import { boxMode, boxSelect } from "../src/select";

const d = new Doc();
const sq = d.add(rectangle(10, 10), translation(20, 20)).id; // 20..30
const ci = d.add(circle(5), translation(60, 25)).id; // 55..65 x 20..30
const ln = d.add(line(40, 0), translation(0, 50)).id; // y=50, x 0..40
const objs = d.state.objects;
const p = (x: number, y: number) => ({ x, y });

describe("boxSelect", () => {
  it("left->right is a window: shape must be fully enclosed", () => {
    expect(boxMode(p(0, 0), p(10, 10))).toBe("window");
    expect(boxSelect(objs, p(15, 15), p(35, 35))).toEqual([sq]);
    expect(boxSelect(objs, p(15, 15), p(28, 35))).toEqual([]); // square only partly inside
  });

  it("right->left is crossing: touching is enough", () => {
    expect(boxMode(p(10, 10), p(0, 0))).toBe("crossing");
    expect(boxSelect(objs, p(28, 35), p(15, 15))).toEqual([sq]);
  });

  it("crossing selects by touching the outline, not by containing the box in the interior", () => {
    expect(boxSelect(objs, p(26, 26), p(24, 24))).toEqual([]); // inside the square, touching nothing
    expect(boxSelect(objs, p(32, 26), p(24, 24))).toEqual([sq]); // right->left, crosses the right edge
  });

  it("window encloses true arcs by their real extent", () => {
    expect(boxSelect(objs, p(54, 19), p(66, 31))).toEqual([ci]);
    expect(boxSelect(objs, p(56, 19), p(66, 31))).toEqual([]); // clips the circle's left side
  });

  it("selects open lines, and several objects at once", () => {
    expect(boxSelect(objs, p(-1, 45), p(41, 55))).toEqual([ln]);
    expect(boxSelect(objs, p(70, 60), p(-5, 10)).sort()).toEqual([sq, ci, ln].sort());
  });
});
