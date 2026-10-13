import { describe, expect, it } from "vitest";
import { boundsOf } from "../src/geometry";
import { kerfTest, testGrid, validateKerfTest, validateTestGrid, type KerfTestParams, type TestGridParams } from "../src/testgrid";

const base: TestGridParams = { powerMin: 20, powerMax: 100, powerSteps: 5, speedMin: 2, speedMax: 10, speedSteps: 3, cellMm: 10, gapMm: 4, labelMm: 3, mode: "cut" };

describe("testGrid", () => {
  const items = testGrid(base);
  const cells = items.filter((i) => i.settings);

  it("makes one square per power x speed, each with its own settings", () => {
    expect(cells.length).toBe(15);
    expect(cells.every((c) => c.layer === "cut" && c.path.closed)).toBe(true);
    const powers = [...new Set(cells.map((c) => c.settings!.powerPct))].sort((a, b) => a - b);
    const speeds = [...new Set(cells.map((c) => c.settings!.speedMmPerS))].sort((a, b) => a - b);
    expect(powers).toEqual([20, 40, 60, 80, 100]);
    expect(speeds).toEqual([2, 6, 10]);
  });

  it("lays cells out on a regular pitch: power left to right, speed bottom to top", () => {
    const at = (p: number, s: number) => boundsOf(cells.find((c) => c.settings!.powerPct === p && c.settings!.speedMmPerS === s)!.path);
    expect(at(20, 2)).toMatchObject({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(at(40, 2).minX).toBe(14);
    expect(at(20, 6).minY).toBe(14);
    expect(at(100, 10)).toMatchObject({ minX: 56, minY: 28 });
  });

  it("scores a label for every column and row, outside the cells", () => {
    const labels = items.filter((i) => !i.settings);
    expect(labels.length).toBeGreaterThan(8);
    expect(labels.every((l) => l.layer === "score")).toBe(true);
    const gridTop = 2 * 14 + 10;
    const colLabels = labels.filter((l) => boundsOf(l.path).minY > gridTop);
    const rowLabels = labels.filter((l) => boundsOf(l.path).maxX < 0);
    expect(colLabels.length).toBeGreaterThan(0);
    expect(rowLabels.length).toBeGreaterThan(0);
    expect(colLabels.length + rowLabels.length).toBe(labels.length); // nothing overlaps the cells
  });

  it("the score variant scores every cell", () => {
    expect(testGrid({ ...base, mode: "score" }).filter((i) => i.settings).every((c) => c.layer === "score")).toBe(true);
  });

  it("a single step uses the minimum", () => {
    const one = testGrid({ ...base, powerSteps: 1, speedSteps: 1 }).filter((i) => i.settings);
    expect(one.length).toBe(1);
    expect(one[0]!.settings).toEqual({ powerPct: 20, speedMmPerS: 2 });
  });
});

describe("validateTestGrid", () => {
  it("accepts good values and explains bad ones", () => {
    expect(validateTestGrid(base)).toBeNull();
    expect(validateTestGrid({ ...base, powerMax: 120 })).toMatch(/Power/);
    expect(validateTestGrid({ ...base, powerMin: 80, powerMax: 20 })).toMatch(/Power/);
    expect(validateTestGrid({ ...base, speedMin: 0 })).toMatch(/Speed/);
    expect(validateTestGrid({ ...base, powerSteps: 0 })).toMatch(/steps/);
    expect(validateTestGrid({ ...base, speedSteps: 2.5 })).toMatch(/steps/);
    expect(validateTestGrid({ ...base, cellMm: 1 })).toMatch(/Cells/);
  });
});

describe("kerfTest", () => {
  const kp: KerfTestParams = { thicknessMm: 3, minWidthMm: 2.7, stepMm: 0.05, count: 8, slotLengthMm: 12, labelMm: 3 };
  const items = kerfTest(kp);
  const cuts = items.filter((i) => i.layer === "cut");
  const scores = items.filter((i) => i.layer === "score");

  it("has a coupon outline plus one slot per width, all cut", () => {
    expect(cuts.length).toBe(1 + 8);
    expect(cuts.every((c) => c.path.closed)).toBe(true);
  });

  it("slot widths step up exactly", () => {
    const slots = cuts.slice(1).map((c) => boundsOf(c.path));
    slots.forEach((b, i) => {
      expect(b.maxX - b.minX).toBeCloseTo(2.7 + i * 0.05, 9);
      expect(b.maxY - b.minY).toBeCloseTo(12, 9);
    });
  });

  it("every slot sits inside the coupon and none overlap", () => {
    const outline = boundsOf(cuts[0]!.path);
    const slots = cuts.slice(1).map((c) => boundsOf(c.path));
    for (const s of slots) {
      expect(s.minX).toBeGreaterThan(outline.minX);
      expect(s.maxX).toBeLessThan(outline.maxX);
      expect(s.minY).toBeGreaterThan(outline.minY);
      expect(s.maxY).toBeLessThan(outline.maxY);
    }
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.minX).toBeGreaterThan(slots[i - 1]!.maxX);
  });

  it("scores a label for each slot, inside the coupon and clear of the slots", () => {
    expect(scores.length).toBeGreaterThanOrEqual(8);
    const outline = boundsOf(cuts[0]!.path);
    const slotBottom = Math.min(...cuts.slice(1).map((c) => boundsOf(c.path).minY));
    for (const l of scores) {
      const b = boundsOf(l.path);
      expect(b.minX).toBeGreaterThanOrEqual(outline.minX);
      expect(b.maxX).toBeLessThanOrEqual(outline.maxX);
      expect(b.maxY).toBeLessThan(slotBottom);
    }
  });

  it("validates", () => {
    expect(validateKerfTest(kp)).toBeNull();
    expect(validateKerfTest({ ...kp, count: 1 })).toMatch(/slots/);
    expect(validateKerfTest({ ...kp, stepMm: 0 })).toMatch(/step/);
    expect(validateKerfTest({ ...kp, thicknessMm: -1 })).toMatch(/Thickness/);
  });
});
