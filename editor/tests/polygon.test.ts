import { describe, expect, it } from "vitest";
import { boundsOf, polylinePath, regularPolygon, flatten } from "../src/geometry";

describe("regularPolygon", () => {
  it("has n vertices, all at radius r, with equal sides", () => {
    for (const n of [3, 4, 5, 6, 8, 12]) {
      const p = regularPolygon(n, 10);
      const pts = flatten(p);
      expect(p.closed).toBe(true);
      expect(p.segs.length).toBe(n - 1); // closing edge is implicit
      expect(pts.length).toBe(n);
      for (const q of pts) expect(Math.hypot(q.x, q.y)).toBeCloseTo(10, 9);
      const sides = pts.map((q, i) => Math.hypot(q.x - pts[(i + 1) % n]!.x, q.y - pts[(i + 1) % n]!.y));
      for (const s of sides) expect(s).toBeCloseTo(2 * 10 * Math.sin(Math.PI / n), 9);
    }
  });

  it("puts the first vertex at the requested angle", () => {
    const p = regularPolygon(5, 4, Math.PI / 2);
    expect(p.start.x).toBeCloseTo(0, 9);
    expect(p.start.y).toBeCloseTo(4, 9);
  });

  it("a square is the expected diamond/box", () => {
    const b = boundsOf(regularPolygon(4, 10, 0));
    expect(b).toMatchObject({ minX: -10, maxX: 10, minY: -10, maxY: 10 });
    const rot = boundsOf(regularPolygon(4, 10, Math.PI / 4));
    expect(rot.maxX).toBeCloseTo(7.0711, 3);
  });

  it("clamps silly side counts to a triangle", () => {
    expect(regularPolygon(1, 5).segs.length).toBe(2);
    expect(regularPolygon(2.6, 5).segs.length).toBe(2); // rounds to 3
  });
});

describe("polylinePath", () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  it("builds a closed polygon from 3+ points", () => {
    const p = polylinePath(pts, true)!;
    expect(p.closed).toBe(true);
    expect(p.start).toEqual({ x: 0, y: 0 });
    expect(p.segs.length).toBe(2);
  });
  it("builds an open polyline from 2+ points", () => {
    expect(polylinePath(pts.slice(0, 2), false)!.closed).toBe(false);
  });
  it("refuses too few points", () => {
    expect(polylinePath(pts.slice(0, 2), true)).toBeNull();
    expect(polylinePath(pts.slice(0, 1), false)).toBeNull();
  });
});
