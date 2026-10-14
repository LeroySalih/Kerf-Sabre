import { describe, expect, it } from "vitest";
import { boundsOf, circle, line, rectangle, type Path } from "../src/geometry";
import { autoTabFractions, lengthToU, nearestFraction, pathLength, segLengths, splitByTabs, tabIntervals, tabPieces, toggleTab } from "../src/tabs";
import { endOf } from "../src/repair";

const rect = rectangle(20, 10); // perimeter 60, starts (0,0) and runs counter-clockwise
const near = (a: { x: number; y: number }, x: number, y: number, d = 6) => { expect(a.x).toBeCloseTo(x, d); expect(a.y).toBeCloseTo(y, d); };
const total = (ps: Path[]) => ps.reduce((s, p) => s + pathLength({ ...p, closed: false }), 0);

describe("lengths", () => {
  it("measure lines, arcs and the implicit closing edge", () => {
    expect(segLengths(rect)).toEqual([20, 10, 20, 10]);
    expect(pathLength(rect)).toBe(60);
    expect(pathLength(circle(5))).toBeCloseTo(2 * Math.PI * 5, 9);
  });
  it("lengthToU maps a distance to a segment and fraction", () => {
    expect(lengthToU(rect, 7.5)).toBeCloseTo(0.375, 9); // 7.5 of the first 20
    expect(lengthToU(rect, 25)).toBeCloseTo(1.5, 9); // halfway along the second edge
    expect(lengthToU(rect, 65)).toBeCloseTo(4 + 5 / 20, 9); // past the seam wraps round
  });
  it("handles curves: a symmetric curve is half way at half its length", () => {
    const c: Path = { start: { x: 0, y: 0 }, segs: [{ t: "c", c1: { x: 0, y: 10 }, c2: { x: 10, y: 10 }, to: { x: 10, y: 0 } }], closed: false };
    expect(lengthToU(c, pathLength(c) / 2)).toBeCloseTo(0.5, 2);
    expect(lengthToU(c, pathLength(c))).toBeCloseTo(1, 6);
  });
});

describe("autoTabFractions", () => {
  it("spaces tabs evenly, half a step in", () => {
    expect(autoTabFractions(4)).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(autoTabFractions(1)).toEqual([0.5]);
    expect(autoTabFractions(0)).toEqual([]);
  });
});

describe("splitByTabs", () => {
  const four = { widthMm: 2, at: autoTabFractions(4) };

  it("leaves four gaps in a rectangle, each exactly the tab width", () => {
    const pieces = splitByTabs(rect, four);
    expect(pieces.length).toBe(4);
    expect(pieces.every((p) => !p.closed)).toBe(true);
    expect(total(pieces)).toBeCloseTo(60 - 8, 6);
    // the tab at s=7.5 spans (6.5,0) to (8.5,0): one piece ends there, the next starts there
    const ends = pieces.map((p) => endOf(p));
    expect(ends.some((e) => Math.abs(e.x - 6.5) < 1e-6 && Math.abs(e.y) < 1e-6)).toBe(true);
    expect(pieces.some((p) => Math.abs(p.start.x - 8.5) < 1e-6 && Math.abs(p.start.y) < 1e-6)).toBe(true);
  });

  it("a tab on the seam gives one piece that runs the long way round", () => {
    const pieces = splitByTabs(rect, { widthMm: 4, at: [0] });
    expect(pieces.length).toBe(1);
    near(pieces[0]!.start, 2, 0);
    near(endOf(pieces[0]!), 0, 2);
    expect(total(pieces)).toBeCloseTo(56, 6);
  });

  it("a tab spanning a corner keeps the outline continuous on either side", () => {
    const pieces = splitByTabs(rect, { widthMm: 4, at: [20 / 60] }); // centred on the corner (20,0)
    expect(pieces.length).toBe(1);
    near(pieces[0]!.start, 20, 2);
    near(endOf(pieces[0]!), 18, 0);
  });

  it("overlapping tabs merge into one gap", () => {
    expect(splitByTabs(rect, { widthMm: 4, at: [0.1, 0.11] }).length).toBe(1);
    expect(tabIntervals(rect, { widthMm: 4, at: [0.1, 0.11] }).length).toBe(1);
  });

  it("circles keep true arcs", () => {
    const pieces = splitByTabs(circle(10), { widthMm: 3, at: autoTabFractions(3) });
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(p.segs.every((s) => s.t === "a")).toBe(true);
    expect(total(pieces)).toBeCloseTo(2 * Math.PI * 10 - 9, 4);
  });

  it("returns the path whole when there is nothing to split", () => {
    expect(splitByTabs(rect, undefined)).toEqual([rect]);
    expect(splitByTabs(rect, { widthMm: 2, at: [] })).toEqual([rect]);
    expect(splitByTabs(rect, { widthMm: 0, at: [0.5] })).toEqual([rect]);
    const open = line(10, 0);
    expect(splitByTabs(open, four)).toEqual([open]); // tabs only apply to closed outlines
  });

  it("never swallows the whole outline, however wide the tabs", () => {
    const pieces = splitByTabs(rect, { widthMm: 500, at: [0.25, 0.75] });
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(total(pieces)).toBeGreaterThan(5);
  });

  it("tabPieces are the removed stretches", () => {
    const gaps = tabPieces(rect, four);
    expect(gaps.length).toBe(4);
    for (const g of gaps) expect(pathLength({ ...g, closed: false })).toBeCloseTo(2, 6);
    expect(total(gaps) + total(splitByTabs(rect, four))).toBeCloseTo(60, 6);
  });

  it("works on a shape that is not at the origin", () => {
    const moved: Path = { start: { x: 100, y: 50 }, segs: [{ t: "l", to: { x: 120, y: 50 } }, { t: "l", to: { x: 120, y: 60 } }, { t: "l", to: { x: 100, y: 60 } }], closed: true };
    const pieces = splitByTabs(moved, four);
    expect(pieces.length).toBe(4);
    const b = boundsOf({ start: pieces[0]!.start, segs: pieces.flatMap((p) => p.segs), closed: false });
    expect(b.minX).toBeGreaterThanOrEqual(100 - 1e-9);
    expect(b.maxX).toBeLessThanOrEqual(120 + 1e-9);
  });
});

describe("click to place", () => {
  it("nearestFraction finds where along the outline a click is", () => {
    expect(nearestFraction(rect, { x: 7.5, y: 0.4 }, 1)).toBeCloseTo(7.5 / 60, 6);
    expect(nearestFraction(rect, { x: 20.3, y: 5 }, 1)).toBeCloseTo(25 / 60, 6);
    expect(nearestFraction(rect, { x: 10, y: 5 }, 1)).toBeNull(); // inside, far from any edge
  });
  it("works around arcs", () => {
    expect(nearestFraction(circle(10), { x: 0, y: 10.2 }, 1)).toBeCloseTo(0.25, 3); // top of the circle, a quarter round
  });
  it("toggleTab adds a tab, then removes it when clicked again", () => {
    const a = toggleTab(undefined, 0.125, 3, rect);
    expect(a).toEqual({ widthMm: 3, at: [0.125] });
    const b = toggleTab(a, 0.14, 3, rect); // within a tab width: removes
    expect(b.at).toEqual([]);
    const c = toggleTab(a, 0.6, 3, rect);
    expect(c.at).toEqual([0.125, 0.6]);
    expect(c.widthMm).toBe(3);
  });
});
