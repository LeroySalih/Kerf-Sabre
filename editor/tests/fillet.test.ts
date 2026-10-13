import { describe, expect, it } from "vitest";
import { boundsOf, circle, flatten, line, rectangle, transformPath, translation, type Path } from "../src/geometry";
import { cornerVertices, filletAll, filletVertices, findCorner, nearestCorner } from "../src/fillet";

const near = (a: { x: number; y: number }, x: number, y: number, d = 9) => { expect(a.x).toBeCloseTo(x, d); expect(a.y).toBeCloseTo(y, d); };
const poly = (pts: [number, number][], closed = true): Path => ({ start: { x: pts[0]![0], y: pts[0]![1] }, segs: pts.slice(1).map(([x, y]) => ({ t: "l" as const, to: { x, y } })), closed });
const arcs = (p: Path) => p.segs.filter((s) => s.t === "a");

describe("cornerVertices", () => {
  it("a rectangle has four corners, including the path start", () => {
    expect(cornerVertices(rectangle(10, 10)).sort()).toEqual([0, 1, 2, 3]);
  });
  it("an open path has only its interior corners", () => {
    expect(cornerVertices(poly([[0, 0], [10, 0], [10, 10]], false))).toEqual([1]);
  });
  it("circles, collinear points and fold-backs are not corners", () => {
    expect(cornerVertices(circle(5))).toEqual([]);
    expect(cornerVertices(poly([[0, 0], [5, 0], [10, 0]], false))).toEqual([]);
    expect(cornerVertices(poly([[0, 0], [10, 0], [0, 0.0001]], false))).toEqual([]);
  });
});

describe("filletVertices: radius", () => {
  it("rounds one square corner with a true arc tangent to both edges", () => {
    const r = filletVertices(rectangle(20, 20), [2], 4, "radius"); // corner at (20,20)
    expect(r.corners).toBe(1);
    expect(r.clamped).toBe(false);
    const a = arcs(r.path)[0]!;
    if (a.t !== "a") throw new Error();
    near(a.c, 16, 16); // centre r in from both edges
    near(a.to, 16, 20);
    expect(a.ccw).toBe(true); // rectangle() runs counter-clockwise
    // the edges now stop where the arc starts
    near(r.path.segs[1]!.to, 20, 16);
  });

  it("keeps the overall size: bounds are unchanged", () => {
    const b = boundsOf(filletAll(rectangle(30, 20), 5, "radius").path);
    expect(b).toMatchObject({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
  });

  it("rounding all four corners gives four arcs and four lines", () => {
    const r = filletAll(rectangle(30, 20), 5, "radius");
    expect(r.corners).toBe(4);
    expect(arcs(r.path).length).toBe(4);
    expect(r.path.segs.filter((s) => s.t === "l").length).toBe(4);
    expect(r.path.closed).toBe(true);
    for (const s of arcs(r.path)) if (s.t === "a") expect(s.ccw).toBe(true);
  });

  it("every arc is exactly r from its centre, and the outline is continuous", () => {
    const r = filletAll(rectangle(30, 20), 5, "radius").path;
    let cur = r.start;
    for (const s of r.segs) {
      if (s.t === "a") expect(Math.hypot(cur.x - s.c.x, cur.y - s.c.y)).toBeCloseTo(5, 9);
      cur = s.to;
    }
    near(cur, r.start.x, r.start.y); // returns to where it began
  });

  it("handles a clockwise outline (arc direction follows the turn)", () => {
    const cw = poly([[0, 0], [0, 10], [10, 10], [10, 0]]); // clockwise
    const r = filletAll(cw, 2, "radius");
    expect(arcs(r.path).length).toBe(4);
    for (const s of arcs(r.path)) if (s.t === "a") expect(s.ccw).toBe(false);
  });

  it("works on sharp and obtuse angles: tangent length = r / tan(angle/2)", () => {
    // a 60 degree corner at the origin, edges along +X and 60 degrees up
    const tri = poly([[10, 0], [0, 0], [5, 8.660254037844386]], false);
    const r = filletVertices(tri, [1], 2, "radius").path;
    const t = 2 / Math.tan(Math.PI / 6); // 3.464
    near(r.segs[0]!.to, t, 0, 6);
    const a = r.segs[1]!;
    if (a.t !== "a") throw new Error();
    expect(Math.hypot(a.c.x - r.segs[0]!.to.x, a.c.y - r.segs[0]!.to.y)).toBeCloseTo(2, 6);
  });

  it("clamps to the room available and says so", () => {
    const r = filletAll(rectangle(10, 10), 8, "radius"); // each edge can give at most half = 5
    expect(r.clamped).toBe(true);
    const a = arcs(r.path)[0]!;
    if (a.t !== "a") throw new Error();
    expect(Math.hypot(a.c.x - a.to.x, a.c.y - a.to.y)).toBeCloseTo(5, 9); // radius shrank to 5
  });

  it("an open path's free ends can use their whole edge", () => {
    const l = poly([[0, 0], [10, 0], [10, 6]], false);
    const r = filletVertices(l, [1], 6, "radius"); // vertical edge is only 6 long: all of it is available
    expect(r.clamped).toBe(false);
    near(r.path.segs[1]!.to.y === undefined ? { x: 0, y: 0 } : (r.path.segs[1] as { to: { x: number; y: number } }).to, 10, 6);
  });

  it("leaves the source untouched", () => {
    const src = rectangle(10, 10);
    const before = JSON.stringify(src);
    filletAll(src, 2, "radius");
    expect(JSON.stringify(src)).toBe(before);
  });

  it("only rounds line-line corners: arcs and lines meeting are skipped", () => {
    const d = filletAll(circle(5), 1, "radius");
    expect(d.corners).toBe(0);
  });
});

describe("filletVertices: chamfer", () => {
  it("cuts the corner with a straight line, setback along each edge", () => {
    const r = filletVertices(rectangle(20, 20), [2], 3, "chamfer");
    expect(arcs(r.path).length).toBe(0);
    near(r.path.segs[1]!.to, 20, 17);
    near(r.path.segs[2]!.to, 17, 20);
  });
  it("chamfering every corner of a square makes an octagon", () => {
    const r = filletAll(rectangle(20, 20), 5, "chamfer");
    expect(r.path.segs.length).toBe(8); // four edges + four chamfers
    expect(new Set(flatten(r.path).map((q) => `${q.x.toFixed(6)},${q.y.toFixed(6)}`)).size).toBe(8); // eight distinct vertices
  });
});

describe("finding corners", () => {
  it("findCorner picks the vertex under the cursor and nothing far away", () => {
    const r = rectangle(10, 10);
    expect(findCorner(r, { x: 10.3, y: 9.8 }, 1)).toBe(2);
    expect(findCorner(r, { x: 0.2, y: 0.1 }, 1)).toBe(0);
    expect(findCorner(r, { x: 5, y: 5 }, 1)).toBeNull();
  });
  it("nearestCorner picks across shapes", () => {
    const a = { id: 1, path: transformPath(rectangle(10, 10), translation(0, 0)) };
    const b = { id: 2, path: transformPath(rectangle(10, 10), translation(10.5, 0)) };
    expect(nearestCorner([a, b], { x: 10.4, y: 0.1 }, 2)).toMatchObject({ item: { id: 2 }, vertex: 0 });
    expect(nearestCorner([a, b], { x: 100, y: 100 }, 2)).toBeNull();
    expect(nearestCorner([{ id: 3, path: line(5, 5) }], { x: 0, y: 0 }, 2)).toBeNull();
  });
});
