import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { IDENTITY, circle, line, rectangle, translation } from "../src/geometry";
import { snapTo } from "../src/snap";

const p = (x: number, y: number) => ({ x, y });

describe("snapTo", () => {
  const setup = () => {
    const d = new Doc();
    const r = d.add(rectangle(20, 10), translation(5, 5)).id; // x 5..25, y 5..15
    return { d, r };
  };

  it("snaps to endpoints (corners)", () => {
    const { d } = setup();
    const s = snapTo(d.state.objects, p(25.4, 14.7), 1)!;
    expect(s.kind).toBe("endpoint");
    expect(s.point).toEqual(p(25, 15));
  });

  it("snaps to midpoints of lines", () => {
    const { d } = setup();
    const s = snapTo(d.state.objects, p(15.3, 4.8), 1)!;
    expect(s.kind).toBe("midpoint");
    expect(s.point).toEqual(p(15, 5));
  });

  it("snaps to arc centres and arc midpoints", () => {
    const d = new Doc();
    d.add(circle(5), translation(50, 50));
    expect(snapTo(d.state.objects, p(50.2, 49.8), 1)).toMatchObject({ kind: "centre", point: p(50, 50) });
    const m = snapTo(d.state.objects, p(50.1, 55.1), 1)!; // top of the circle = midpoint of the 180-degree arc
    expect(m.kind).toBe("midpoint");
    expect(m.point.y).toBeCloseTo(55, 9);
  });

  it("snaps to the intersection of two lines", () => {
    const d = new Doc();
    d.add(line(20, 0), translation(0, 5)); // y=5
    d.add(line(0, 20), translation(7, 0)); // x=7
    const s = snapTo(d.state.objects, p(7.3, 5.2), 1)!;
    expect(s.kind).toBe("intersection");
    expect(s.point.x).toBeCloseTo(7, 9);
    expect(s.point.y).toBeCloseTo(5, 9);
  });

  it("prefers an endpoint over a midpoint at the same distance", () => {
    const d = new Doc();
    d.add(line(2, 0), IDENTITY); // endpoints at x=0 and 2, midpoint at x=1
    const s = snapTo(d.state.objects, p(1, 0), 5)!;
    expect(s.dist).toBe(0);
    expect(s.kind).toBe("midpoint"); // exactly on the midpoint: nearest wins
    expect(snapTo(d.state.objects, p(0.05, 0), 5)!.kind).toBe("endpoint");
  });

  it("falls back to the 1 cm grid only when enabled and nothing else is near", () => {
    const d = new Doc();
    expect(snapTo(d.state.objects, p(31, 19), 2, { grid: true })).toMatchObject({ kind: "grid", point: p(30, 20) });
    expect(snapTo(d.state.objects, p(31, 19), 2)).toBeNull();
    expect(snapTo(d.state.objects, p(34, 24), 2, { grid: true })).toBeNull(); // too far from any grid point
    const { d: d2 } = setup();
    expect(snapTo(d2.state.objects, p(5.2, 5.3), 2, { grid: true })!.kind).toBe("endpoint"); // objects beat the grid
  });

  it("respects the tolerance and exclusions", () => {
    const { d, r } = setup();
    expect(snapTo(d.state.objects, p(40, 40), 1)).toBeNull();
    expect(snapTo(d.state.objects, p(25, 15), 1, { exclude: new Set([r]) })).toBeNull();
  });

  it("uses placed geometry (matrices applied)", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), translation(100, 200));
    expect(snapTo(d.state.objects, p(110.1, 210.1), 1)!.point).toEqual(p(110, 210));
  });
});
