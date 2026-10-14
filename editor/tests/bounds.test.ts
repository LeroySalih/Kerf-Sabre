import { describe, expect, it } from "vitest";
import { canSubmit, outOfBounds } from "../src/bounds";
import { Doc } from "../src/doc";
import { circle, rectangle, translation } from "../src/geometry";

const bed = { widthMm: 400, heightMm: 300 };

describe("outOfBounds", () => {
  it("flags shapes that cross any bed edge", () => {
    const d = new Doc();
    const ok = d.add(rectangle(10, 10), translation(5, 5)).id;
    const left = d.add(rectangle(10, 10), translation(-1, 50)).id;
    const right = d.add(rectangle(10, 10), translation(395, 50)).id;
    const top = d.add(rectangle(10, 10), translation(50, 295)).id;
    const bottom = d.add(rectangle(10, 10), translation(50, -0.5)).id;
    const flagged = outOfBounds(d.state.objects, bed);
    expect(flagged.sort()).toEqual([left, right, top, bottom].sort());
    expect(flagged).not.toContain(ok);
  });

  it("a shape exactly on the edge is inside", () => {
    const d = new Doc();
    d.add(rectangle(400, 300), translation(0, 0));
    expect(outOfBounds(d.state.objects, bed)).toEqual([]);
  });

  it("uses the true extent of arcs", () => {
    const d = new Doc();
    const c = d.add(circle(5), translation(4, 100)).id; // spans x -1..9
    expect(outOfBounds(d.state.objects, bed)).toEqual([c]);
  });
});

describe("canSubmit", () => {
  it("needs at least one object and none outside the bed", () => {
    const d = new Doc();
    expect(canSubmit(d.state.objects, bed)).toBe(false);
    d.add(rectangle(10, 10), translation(5, 5));
    expect(canSubmit(d.state.objects, bed)).toBe(true);
    d.add(rectangle(10, 10), translation(-5, 5));
    expect(canSubmit(d.state.objects, bed)).toBe(false);
  });
});
