import { describe, expect, it } from "vitest";
import { boundsOf, flatten } from "../src/geometry";
import { boxNet, validateBoxNet, type BoxNetParams } from "../src/boxnet";

const base: BoxNetParams = { widthMm: 80, depthMm: 60, heightMm: 30, flanges: false, flangeMm: 10 };
const cuts = (p: BoxNetParams) => boxNet(p).filter((i) => i.layer === "cut");
const scores = (p: BoxNetParams) => boxNet(p).filter((i) => i.layer === "score");

describe("boxNet", () => {
  it("makes a plain cross: one closed cut outline and the four base folds", () => {
    expect(cuts(base)).toHaveLength(1);
    const outline = cuts(base)[0]!.path;
    expect(outline.closed).toBe(true);
    expect(boundsOf(outline)).toMatchObject({ minX: -30, maxX: 110, minY: -30, maxY: 90 });
    const s = scores(base);
    expect(s).toHaveLength(4);
    expect(s.every((i) => !i.path.closed)).toBe(true);
    const b = s.map((i) => boundsOf(i.path));
    expect(b.some((r) => r.minX === 0 && r.maxX === 80 && r.minY === 0 && r.maxY === 0)).toBe(true);
    expect(b.some((r) => r.minX === 0 && r.maxX === 0 && r.minY === 0 && r.maxY === 60)).toBe(true);
  });

  it("has 12 corners without flanges (a plus shape)", () => {
    expect(flatten(cuts(base)[0]!.path).length).toBeGreaterThanOrEqual(12);
  });

  it("adds four glue flanges: extra outline corners and a fold line on each", () => {
    const p = { ...base, flanges: true };
    expect(cuts(p)).toHaveLength(1);
    expect(scores(p)).toHaveLength(8);
    expect(flatten(cuts(p)[0]!.path).length).toBeGreaterThan(flatten(cuts(base)[0]!.path).length);
  });

  it("reaches out by the flange width when the flange is longer than the wall is high", () => {
    const p = { ...base, heightMm: 12, flanges: true, flangeMm: 20 };
    expect(boundsOf(cuts(p)[0]!.path)).toMatchObject({ minY: -20, maxY: 80 });
  });

  it("keeps every shape inside the outline's box", () => {
    const p = { ...base, flanges: true };
    const box = boundsOf(cuts(p)[0]!.path);
    for (const i of boxNet(p)) {
      const b = boundsOf(i.path);
      expect(b.minX).toBeGreaterThanOrEqual(box.minX - 1e-9);
      expect(b.maxX).toBeLessThanOrEqual(box.maxX + 1e-9);
      expect(b.minY).toBeGreaterThanOrEqual(box.minY - 1e-9);
      expect(b.maxY).toBeLessThanOrEqual(box.maxY + 1e-9);
    }
  });
});

describe("validateBoxNet", () => {
  it("accepts sensible boxes", () => {
    expect(validateBoxNet(base)).toBeNull();
    expect(validateBoxNet({ ...base, flanges: true })).toBeNull();
  });
  it("rejects tiny or impossible boxes", () => {
    expect(validateBoxNet({ ...base, widthMm: 5 })).toMatch(/at least 10/);
    expect(validateBoxNet({ ...base, flanges: true, flangeMm: 45 })).toMatch(/too wide/);
    expect(validateBoxNet({ ...base, flanges: true, flangeMm: 2 })).toMatch(/at least 3/);
  });
});
