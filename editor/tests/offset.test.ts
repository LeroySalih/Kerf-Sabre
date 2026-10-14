import { describe, expect, it } from "vitest";
import { arcSweep, circle, flatten, polylinePath, rectangle, transformPath, translation, type Path } from "../src/geometry";
import { offsetPath } from "../src/offset";

const P = (x: number, y: number) => ({ x, y });
const area = (p: Path) => {
  const pts = flatten(p, 0.002);
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[i]!, r = pts[(i + 1) % pts.length]!; a += q.x * r.y - r.x * q.y; }
  return Math.abs(a / 2);
};
const bounds = (p: Path) => {
  const pts = flatten(p, 0.002);
  return { minX: Math.min(...pts.map((q) => q.x)), maxX: Math.max(...pts.map((q) => q.x)), minY: Math.min(...pts.map((q) => q.y)), maxY: Math.max(...pts.map((q) => q.y)) };
};
const rect = (x: number, y: number, w: number, h: number) => transformPath(rectangle(w, h), translation(x, y));
const arcs = (p: Path) => p.segs.filter((s) => s.t === "a");

describe("closed shapes", () => {
  it("a rectangle grows by the distance, with true arcs at the rounded corners", () => {
    const [out] = offsetPath(rect(10, 10, 40, 20), { distance: 3, side: "outside", corner: "round" });
    expect(out!.closed).toBe(true);
    const b = bounds(out!);
    expect([b.minX, b.maxX, b.minY, b.maxY].map((v) => Math.round(v * 100) / 100)).toEqual([7, 53, 7, 33]);
    expect(area(out!)).toBeCloseTo(800 + 2 * 60 * 3 + Math.PI * 9, 1);
    const a = arcs(out!);
    expect(a).toHaveLength(4);
    for (const s of a) if (s.t === "a") expect(Math.hypot(s.c.x - 10, s.c.y - 10) === 0 || [P(10, 10), P(50, 10), P(50, 30), P(10, 30)].some((c) => Math.hypot(s.c.x - c.x, s.c.y - c.y) < 1e-6)).toBe(true);
  });

  it("sharp corners stay sharp (mitred): a plain larger rectangle", () => {
    const [out] = offsetPath(rect(10, 10, 40, 20), { distance: 3, side: "outside", corner: "sharp" });
    expect(arcs(out!)).toHaveLength(0);
    expect(out!.segs).toHaveLength(4);
    expect(area(out!)).toBeCloseTo(46 * 26, 2);
  });

  it("inside shrinks it", () => {
    const [out] = offsetPath(rect(10, 10, 40, 20), { distance: 3, side: "inside", corner: "round" });
    expect(area(out!)).toBeCloseTo(34 * 14, 2);
    expect(arcs(out!)).toHaveLength(0); // an inward offset of a convex shape has sharp corners
  });

  it("a circle stays a circle (arcs about the same centre, radius +/- d)", () => {
    const c = transformPath(circle(10), translation(50, 50));
    const [out] = offsetPath(c, { distance: 3, side: "outside", corner: "round" });
    expect(out!.segs.every((s) => s.t === "a")).toBe(true);
    for (const s of out!.segs) if (s.t === "a") { expect(s.c.x).toBeCloseTo(50, 2); expect(s.c.y).toBeCloseTo(50, 2); }
    expect(Math.hypot(out!.start.x - 50, out!.start.y - 50)).toBeCloseTo(13, 3);
    const total = out!.segs.reduce((acc, s, i) => acc + (s.t === "a" ? Math.abs(arcSweep(s.c, i ? out!.segs[i - 1]!.to : out!.start, s.to, s.ccw)) : 0), 0);
    expect(total).toBeCloseTo(2 * Math.PI, 2);
    expect(out!.segs.length).toBeLessThanOrEqual(3);
    const [inner] = offsetPath(c, { distance: 3, side: "inside", corner: "round" });
    expect(Math.hypot(inner!.start.x - 50, inner!.start.y - 50)).toBeCloseTo(7, 3);
  });

  it("an inward offset larger than the shape leaves nothing", () => {
    expect(offsetPath(rect(0, 0, 10, 6), { distance: 4, side: "inside", corner: "round" })).toEqual([]);
  });

  it("both sides gives two closed shapes", () => {
    const r = offsetPath(rect(0, 0, 40, 40), { distance: 5, side: "both", corner: "sharp" });
    expect(r.map(area).sort((a, b) => a - b).map((a) => Math.round(a))).toEqual([900, 2500]);
  });

  it("is the same wherever the shape is drawn from (direction of the path does not matter)", () => {
    const cw = polylinePath([P(0, 0), P(0, 20), P(40, 20), P(40, 0)], true)!;
    const ccw = polylinePath([P(0, 0), P(40, 0), P(40, 20), P(0, 20)], true)!;
    expect(area(offsetPath(cw, { distance: 2, side: "outside", corner: "sharp" })[0]!)).toBeCloseTo(44 * 24, 2);
    expect(area(offsetPath(ccw, { distance: 2, side: "outside", corner: "sharp" })[0]!)).toBeCloseTo(44 * 24, 2);
  });

  it("an L shape's inner corner is trimmed cleanly, not left with a loop", () => {
    const L = polylinePath([P(0, 0), P(40, 0), P(40, 10), P(10, 10), P(10, 40), P(0, 40)], true)!;
    const [out] = offsetPath(L, { distance: 2, side: "outside", corner: "sharp" });
    expect(offsetPath(L, { distance: 2, side: "outside", corner: "sharp" })).toHaveLength(1);
    const b = bounds(out!);
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([-2, -2, 42, 42]);
  });
});

describe("open lines", () => {
  const line = polylinePath([P(0, 0), P(50, 0)], false)!;
  it("a straight line gives a parallel line, left or right of the way it runs", () => {
    const [left] = offsetPath(line, { distance: 5, side: "outside", corner: "round" });
    expect(left!.closed).toBe(false);
    expect(left!.start.x).toBeCloseTo(0, 3);
    expect(left!.start.y).toBeCloseTo(5, 3);
    expect(left!.segs).toHaveLength(1);
    expect(left!.segs[0]!.to.x).toBeCloseTo(50, 3);
    expect(left!.segs[0]!.to.y).toBeCloseTo(5, 3);
    const [right] = offsetPath(line, { distance: 5, side: "inside", corner: "round" });
    expect(right!.start.y).toBeCloseTo(-5, 3);
    expect(right!.start.x).toBeCloseTo(0, 3); // still runs the same way as the original
    expect(offsetPath(line, { distance: 5, side: "both", corner: "round" })).toHaveLength(2);
  });

  it("a bend: round on the outside of the corner, trimmed on the inside", () => {
    const bend = polylinePath([P(0, 0), P(40, 0), P(40, 30)], false)!;
    const right = offsetPath(bend, { distance: 4, side: "inside", corner: "round" }); // right of the way it runs = outside of this left turn? (it turns left, so right is outside)
    const left = offsetPath(bend, { distance: 4, side: "outside", corner: "round" });
    expect(right).toHaveLength(1);
    expect(left).toHaveLength(1);
    expect(arcs(right[0]!)).toHaveLength(1);
    expect(arcs(left[0]!)).toHaveLength(0);
    const l = left[0]!;
    expect(l.segs).toHaveLength(2); // two straight pieces meeting at the trimmed corner
    expect(l.segs[0]!.to.x).toBeCloseTo(36, 3);
    expect(l.segs[0]!.to.y).toBeCloseTo(4, 3);
  });

  it("an arc offsets to a concentric arc", () => {
    const arc: Path = { start: P(20, 0), segs: [{ t: "a", c: P(0, 0), to: P(0, 20), ccw: true }], closed: false };
    const [out] = offsetPath(arc, { distance: 5, side: "outside", corner: "round" }); // left of a ccw arc is inside it
    expect(out!.segs).toHaveLength(1);
    const s = out!.segs[0]!;
    expect(s.t).toBe("a");
    if (s.t === "a") { expect(s.c.x).toBeCloseTo(0, 3); expect(Math.hypot(out!.start.x, out!.start.y)).toBeCloseTo(15, 3); }
  });

  it("an offset of a long curve stays close to it with a sensible number of segments", () => {
    const wave = polylinePath(Array.from({ length: 200 }, (_, i) => P(i, 10 * Math.sin(i / 12))), false)!; // a smooth polyline
    const [out] = offsetPath(wave, { distance: 2, side: "outside", corner: "round" });
    expect(out!.segs.length).toBeLessThan(260);
    for (const s of out!.segs) expect(Number.isFinite(s.to.x) && Number.isFinite(s.to.y)).toBe(true);
    const pts = flatten(out!, 0.01);
    const src = flatten(wave, 0.01);
    const off = (p: { x: number; y: number }) => Math.min(...src.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
    for (const p of pts.filter((_, i) => i % 7 === 0)) expect(Math.abs(off(p) - 2)).toBeLessThan(0.05);
  });

  it("a distance of zero or less does nothing", () => {
    expect(offsetPath(line, { distance: 0, side: "outside", corner: "round" })).toEqual([]);
    expect(offsetPath(line, { distance: -2, side: "outside", corner: "round" })).toEqual([]);
  });
});
