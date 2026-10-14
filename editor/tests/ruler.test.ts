import { describe, expect, it } from "vitest";
import { measure, formatMeasurement, rulerTicks } from "../src/ruler";

describe("rulerTicks", () => {
  const view = { scale: 2, originPx: { x: 100, y: 500 } }; // 2 px/mm, bed (0,0) at (100,500)

  it("places ticks at the right pixel for each mm value (x axis)", () => {
    const t = rulerTicks(view, "x", 400);
    const t10 = t.find((k) => k.mm === 10)!;
    expect(t10.px).toBe(120);
    expect(t.every((k) => k.px >= -1 && k.px <= 401)).toBe(true);
  });

  it("y axis counts upwards: larger mm is nearer the top", () => {
    const t = rulerTicks(view, "y", 500);
    expect(t.find((k) => k.mm === 0)!.px).toBe(500);
    expect(t.find((k) => k.mm === 50)!.px).toBe(400);
  });

  it("keeps minor ticks at least 8 px apart at any zoom", () => {
    for (const scale of [0.1, 0.5, 1, 2, 10, 50]) {
      const t = rulerTicks({ scale, originPx: { x: 0, y: 0 } }, "x", 1000);
      for (let i = 1; i < t.length; i++) expect(t[i]!.px - t[i - 1]!.px).toBeGreaterThanOrEqual(7.99);
    }
  });

  it("marks sparser major ticks, and zero is major", () => {
    const t = rulerTicks({ scale: 2, originPx: { x: 100, y: 0 } }, "x", 400);
    expect(t.find((k) => k.mm === 0)!.major).toBe(true);
    expect(t.filter((k) => k.major).length).toBeLessThan(t.length);
  });
});

describe("measure", () => {
  it("gives distance, deltas and a counter-clockwise angle", () => {
    const m = measure({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(m.distMm).toBe(5);
    expect(m.dxMm).toBe(3);
    expect(m.dyMm).toBe(4);
    expect(m.angleDeg).toBeCloseTo(53.1301, 3);
    expect(measure({ x: 0, y: 0 }, { x: 0, y: -1 }).angleDeg).toBeCloseTo(-90, 9);
  });
  it("formats to two decimals", () => {
    expect(formatMeasurement(measure({ x: 0, y: 0 }, { x: 3, y: 4 }))).toBe("5.00 mm  (dx 3.00, dy 4.00)  53.13°");
  });
});
