import { describe, expect, it } from "vitest";
import { roundedRectangle } from "../src/fillet";
import { boundsOf, ellipse, flatten, star } from "../src/geometry";

describe("ellipse", () => {
  it("fits its radii", () => {
    const b = boundsOf(ellipse(10, 5));
    expect(b.minX).toBeCloseTo(-10, 1);
    expect(b.maxX).toBeCloseTo(10, 1);
    expect(b.minY).toBeCloseTo(-5, 1);
    expect(b.maxY).toBeCloseTo(5, 1);
  });
  it("is closed, four curves, and points lie on the ellipse to within 0.03%", () => {
    const e = ellipse(20, 8);
    expect(e.closed).toBe(true);
    expect(e.segs.length).toBe(4);
    for (const p of flatten(e, 0.01)) expect(Math.abs((p.x / 20) ** 2 + (p.y / 8) ** 2 - 1)).toBeLessThan(6e-4);
  });
  it("with equal radii it is a circle", () => {
    for (const p of flatten(ellipse(7, 7), 0.01)) expect(Math.hypot(p.x, p.y)).toBeCloseTo(7, 1);
  });
});

describe("star", () => {
  it("has 2n vertices alternating tip and valley radii", () => {
    const pts = flatten(star(5, 10, 4));
    expect(pts.length).toBe(10); // 10 distinct vertices; the closing edge is implicit
    pts.forEach((p, i) => expect(Math.hypot(p.x, p.y)).toBeCloseTo(i % 2 === 0 ? 10 : 4, 9));
  });
  it("starts at the requested angle", () => {
    const p = star(6, 10, 5, Math.PI / 2).start;
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(10, 9);
  });
  it("needs at least three points", () => {
    expect(star(1, 10, 4).segs.length).toBe(5);
  });
});

describe("roundedRectangle", () => {
  it("keeps the rectangle's size, with four true arcs", () => {
    const p = roundedRectangle(30, 20, 5);
    expect(boundsOf(p)).toMatchObject({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
    expect(p.segs.filter((s) => s.t === "a").length).toBe(4);
  });
  it("limits the radius to half the shorter side (a stadium)", () => {
    const p = roundedRectangle(40, 10, 99);
    const arcs = p.segs.filter((s) => s.t === "a");
    expect(arcs.length).toBe(4);
    expect(boundsOf(p)).toMatchObject({ minX: 0, maxX: 40, minY: 0, maxY: 10 });
  });
  it("a zero radius is a plain rectangle", () => {
    expect(roundedRectangle(10, 10, 0).segs.every((s) => s.t === "l")).toBe(true);
  });
});
