import { describe, expect, it } from "vitest";
import { booleanOp, cubicAsArc, mergeArcs } from "../src/boolean";
import { boundsOf, circle, flatten, rectangle, regularPolygon, transformPath, translation, type Path } from "../src/geometry";

const at = (p: Path, x: number, y: number) => transformPath(p, translation(x, y));
/** Unsigned polygon area of a contour (curves flattened finely). */
const area = (p: Path) => {
  const pts = flatten(p, 0.001);
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]!; a += pts[i]!.x * q.y - q.x * pts[i]!.y; }
  return Math.abs(a / 2);
};
const total = (ps: Path[]) => ps.reduce((s, p) => s + area(p), 0);

describe("booleanOp on rectangles", () => {
  const a = [rectangle(10, 10)];
  const b = [at(rectangle(10, 10), 5, 5)];

  it("union covers both: 100 + 100 - 25", () => {
    const r = booleanOp("union", [a, b]);
    expect(r.error).toBeUndefined();
    expect(r.paths.length).toBe(1);
    expect(area(r.paths[0]!)).toBeCloseTo(175, 6);
  });

  it("intersect keeps only the overlap", () => {
    const r = booleanOp("intersect", [a, b]);
    expect(r.paths.length).toBe(1);
    expect(area(r.paths[0]!)).toBeCloseTo(25, 6);
    expect(boundsOf(r.paths[0]!)).toMatchObject({ minX: 5, maxX: 10, minY: 5, maxY: 10 });
  });

  it("subtract removes the later shape from the first", () => {
    const r = booleanOp("subtract", [a, b]);
    expect(area(r.paths[0]!)).toBeCloseTo(75, 6);
    const rev = booleanOp("subtract", [b, a]);
    expect(boundsOf(rev.paths[0]!)).toMatchObject({ minX: 5, maxX: 15, minY: 5, maxY: 15 });
  });

  it("subtracting a shape from inside another leaves a hole as a second contour", () => {
    const r = booleanOp("subtract", [[rectangle(10, 10)], [at(rectangle(4, 4), 3, 3)]]);
    expect(r.paths.length).toBe(2);
    expect(r.paths.map(area).sort((x, y) => x - y).map((v) => Math.round(v))).toEqual([16, 100]);
  });

  it("works across more than two shapes", () => {
    const r = booleanOp("union", [a, b, [at(rectangle(10, 10), 10, 10)]]);
    expect(r.paths.length).toBe(1);
    expect(area(r.paths[0]!)).toBeCloseTo(100 + 100 + 100 - 25 - 25, 6);
  });
});

describe("booleanOp errors", () => {
  it("reports disjoint intersections", () => {
    const r = booleanOp("intersect", [[rectangle(5, 5)], [at(rectangle(5, 5), 50, 50)]]);
    expect(r.paths).toEqual([]);
    expect(r.error).toMatch(/do not overlap/);
  });
  it("needs two operands and closed shapes", () => {
    expect(booleanOp("union", [[rectangle(5, 5)]]).error).toMatch(/at least two/);
    const open: Path = { start: { x: 0, y: 0 }, segs: [{ t: "l", to: { x: 5, y: 5 } }], closed: false };
    expect(booleanOp("union", [[rectangle(5, 5)], [open]]).error).toMatch(/closed/);
  });
  it("subtracting a shape from itself leaves nothing", () => {
    expect(booleanOp("subtract", [[rectangle(5, 5)], [rectangle(5, 5)]]).paths).toEqual([]);
  });
});

describe("compound operands (groups, text)", () => {
  it("a donut stays a donut when unioned with a far-away shape", () => {
    const donut = [rectangle(20, 20), at(rectangle(8, 8), 6, 6)];
    const r = booleanOp("union", [donut, [at(rectangle(5, 5), 100, 100)]]);
    expect(r.paths.length).toBe(3); // outer, hole, extra square
    expect(Math.round(total(r.paths.filter((p) => boundsOf(p).minX < 50)) )).toBe(400 + 64); // outer + hole areas (unsigned)
  });
  it("a shape dropped into the hole is not swallowed", () => {
    const donut = [rectangle(20, 20), at(rectangle(8, 8), 6, 6)];
    const r = booleanOp("union", [donut, [at(rectangle(2, 2), 9, 9)]]);
    expect(r.paths.length).toBe(3);
  });
});

describe("arcs survive booleans", () => {
  it("a circle clipped by a rectangle keeps true arcs", () => {
    const r = booleanOp("intersect", [[circle(10)], [at(rectangle(30, 30), -5, -15)]]);
    expect(r.paths.length).toBe(1);
    const kinds = r.paths[0]!.segs.map((s) => s.t);
    expect(kinds).toContain("a");
    expect(kinds).not.toContain("c");
    for (const s of r.paths[0]!.segs) if (s.t === "a") expect(Math.hypot(s.c.x, s.c.y)).toBeCloseTo(0, 9); // exactly the original circle
  });

  it("two overlapping circles unite into exactly two arcs", () => {
    const r = booleanOp("union", [[circle(10)], [at(circle(10), 12, 0)]]);
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]!.segs.every((s) => s.t === "a")).toBe(true);
    expect(r.paths[0]!.segs.length).toBe(2);
  });

  it("a polygon stays lines", () => {
    const r = booleanOp("union", [[regularPolygon(6, 10)], [at(regularPolygon(6, 10), 5, 0)]]);
    expect(r.paths[0]!.segs.every((s) => s.t === "l")).toBe(true);
  });

  it("cubicAsArc recognises a quarter circle and rejects an S-curve", () => {
    const k = 0.5522847498;
    const arc = cubicAsArc({ x: 10, y: 0 }, { x: 10, y: 10 * k }, { x: 10 * k, y: 10 }, { x: 0, y: 10 });
    expect(arc && arc.t === "a" && arc.ccw).toBe(true);
    if (arc && arc.t === "a") { expect(arc.c.x).toBeCloseTo(0, 3); expect(arc.c.y).toBeCloseTo(0, 3); }
    expect(cubicAsArc({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 5, y: -10 }, { x: 10, y: 0 })).toBeNull();
    expect(cubicAsArc({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }, { x: 10, y: 0 })).toBeNull(); // straight
  });

  it("mergeArcs joins same-circle neighbours but not a full turn", () => {
    const c = { x: 0, y: 0 };
    const half1 = { t: "a" as const, c, to: { x: -10, y: 0 }, ccw: true };
    const half2 = { t: "a" as const, c, to: { x: 10, y: 0 }, ccw: true };
    expect(mergeArcs({ x: 10, y: 0 }, [half1, half2]).length).toBe(2); // would be 360 degrees: keep as two
    const q1 = { t: "a" as const, c, to: { x: 0, y: 10 }, ccw: true };
    const q2 = { t: "a" as const, c, to: { x: -10, y: 0 }, ccw: true };
    const m = mergeArcs({ x: 10, y: 0 }, [q1, q2]);
    expect(m.length).toBe(1);
    expect(m[0]).toMatchObject({ t: "a", ccw: true, to: { x: -10, y: 0 } });
  });
});
