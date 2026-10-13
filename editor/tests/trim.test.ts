import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { IDENTITY, circle, line, rectangle, translation, type Path } from "../src/geometry";
import { planTrim } from "../src/trim";

const p = (x: number, y: number) => ({ x, y });
const end = (path: Path) => path.segs[path.segs.length - 1]!.to;
const near = (a: { x: number; y: number }, x: number, y: number) => {
  expect(a.x).toBeCloseTo(x, 6);
  expect(a.y).toBeCloseTo(y, 6);
};

describe("planTrim: lines", () => {
  // Horizontal line y=0, x -10..10, crossed by a vertical line at x=0 (y -10..10)
  const cross = () => {
    const d = new Doc();
    const h = d.add(line(20, 0), translation(-10, 0)).id;
    const v = d.add(line(0, 20), translation(0, -10)).id;
    return { d, h, v };
  };

  it("removes the part of a line past the intersection, on the side clicked", () => {
    const { d, h } = cross();
    const plan = planTrim(d.state.objects, p(5, 0), 1)!;
    expect(plan.objectId).toBe(h);
    expect(plan.keep.length).toBe(1);
    near(plan.keep[0]!.start, -10, 0);
    near(end(plan.keep[0]!), 0, 0);
    near(plan.removed.start, 0, 0);
    near(end(plan.removed), 10, 0);
  });

  it("works on the other side too", () => {
    const { d } = cross();
    const plan = planTrim(d.state.objects, p(-5, 0), 1)!;
    near(plan.keep[0]!.start, 0, 0);
    near(end(plan.keep[0]!), 10, 0);
  });

  it("clicking between two intersections leaves two pieces", () => {
    const d = new Doc();
    d.add(line(30, 0), translation(0, 0));
    d.add(line(0, 10), translation(10, -5));
    d.add(line(0, 10), translation(20, -5));
    const plan = planTrim(d.state.objects, p(15, 0), 1)!;
    expect(plan.keep.length).toBe(2);
    near(end(plan.keep[0]!), 10, 0);
    near(plan.keep[1]!.start, 20, 0);
    near(end(plan.keep[1]!), 30, 0);
  });

  it("a line with no intersections is removed entirely", () => {
    const d = new Doc();
    d.add(line(20, 0), IDENTITY);
    const plan = planTrim(d.state.objects, p(10, 0), 1)!;
    expect(plan.keep).toEqual([]);
  });

  it("returns null when the click is nowhere near geometry", () => {
    const { d } = cross();
    expect(planTrim(d.state.objects, p(50, 50), 1)).toBeNull();
  });

  it("respects the object's placement matrix", () => {
    const d = new Doc();
    d.add(line(20, 0), translation(100, 100));
    d.add(line(0, 20), translation(110, 90));
    const plan = planTrim(d.state.objects, p(118, 100), 1)!;
    near(plan.keep[0]!.start, 100, 100);
    near(end(plan.keep[0]!), 110, 100);
  });
});

describe("planTrim: shapes", () => {
  it("a rectangle edge is trimmed between its corners when nothing crosses it", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), IDENTITY); // closed, 4 corners
    const plan = planTrim(d.state.objects, p(5, 0), 1)!;
    expect(plan.keep.length).toBe(1);
    expect(plan.keep[0]!.segs.length).toBe(3); // the other three edges, now an open path
    near(plan.removed.start, 0, 0);
    near(end(plan.removed), 10, 0);
  });

  it("a crossing line trims a rectangle edge only up to the intersection", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), IDENTITY);
    d.add(line(0, 20), translation(4, -5)); // crosses the bottom edge at (4,0) and top at (4,10)
    const plan = planTrim(d.state.objects, p(7, 0), 1)!;
    near(plan.removed.start, 4, 0);
    near(end(plan.removed), 10, 0);
  });

  it("trimming a circle between two line crossings keeps the rest as true arcs", () => {
    const d = new Doc();
    d.add(circle(10), translation(0, 0));
    d.add(line(30, 0), translation(-15, 5)); // y=5 crosses the circle twice
    const plan = planTrim(d.state.objects, p(0, 10), 1)!; // top of the circle, between the crossings
    expect(plan.keep.length).toBe(1);
    const kept = plan.keep[0]!;
    expect(kept.segs.every((s) => s.t === "a")).toBe(true);
    const x = Math.sqrt(100 - 25);
    // the circle runs counter-clockwise from (10,0): it meets the right crossing first, then the left
    near(kept.start, -x, 5);
    near(end(kept), x, 5);
    // the removed arc is the short top arc, right crossing -> left crossing
    near(plan.removed.start, x, 5);
    near(end(plan.removed), -x, 5);
  });

  it("refuses to wipe a closed loop that has no boundaries", () => {
    const d = new Doc();
    d.add(circle(10), IDENTITY);
    expect(planTrim(d.state.objects, p(0, 10), 1)).toBeNull();
  });

  it("trims a line against an arc", () => {
    const d = new Doc();
    d.add(line(40, 0), translation(-20, 0)); // y=0
    d.add(circle(10), IDENTITY); // crosses at x=-10 and x=10
    const plan = planTrim(d.state.objects, p(-15, 0), 1)!;
    expect(plan.objectId).toBe(1);
    near(plan.keep[0]!.start, -10, 0);
    near(end(plan.keep[0]!), 20, 0);
  });

  it("does not treat the shared vertex of adjacent segments as an intersection", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), IDENTITY);
    const plan = planTrim(d.state.objects, p(2, 0), 1)!;
    near(plan.removed.start, 0, 0); // whole edge, corner to corner
    near(end(plan.removed), 10, 0);
  });
});
