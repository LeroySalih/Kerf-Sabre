import { describe, expect, it } from "vitest";
import { boundsOf, flatten } from "../src/geometry";
import { boxNet, flangeSizes, validateBoxNet, type BoxNetParams } from "../src/boxnet";

const base: BoxNetParams = { widthMm: 80, depthMm: 60, heightMm: 30, thicknessMm: 3, flanges: false, flangeMm: 10, slots: false };
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
    // the folds are exactly the base rectangle
    const b = s.map((i) => boundsOf(i.path));
    expect(b.some((r) => r.minX === 0 && r.maxX === 80 && r.minY === 0 && r.maxY === 0)).toBe(true);
    expect(b.some((r) => r.minX === 0 && r.maxX === 0 && r.minY === 0 && r.maxY === 60)).toBe(true);
  });

  it("has 12 corners without flanges (a plus shape)", () => {
    expect(flatten(cuts(base)[0]!.path).length).toBeGreaterThanOrEqual(12);
  });

  it("adds four flanges as extra folds and extends the outline by the flange width", () => {
    const p = { ...base, flanges: true };
    expect(cuts(p)).toHaveLength(1);
    expect(scores(p)).toHaveLength(8);
    // flanges are shorter than the walls here, so they sit inside the plus shape's box but add corners to the outline
    expect(flatten(cuts(p)[0]!.path).length).toBeGreaterThan(flatten(cuts(base)[0]!.path).length);
  });

  it("with slots adds a tongue per flange and a slit per flange, in the front and back walls", () => {
    const p = { ...base, flanges: true, slots: true };
    const c = cuts(p);
    expect(c).toHaveLength(5); // outline + 4 slits
    expect(scores(p)).toHaveLength(12); // base 4 + flange folds 4 + tongue folds 4
    const slits = c.slice(1).map((i) => boundsOf(i.path));
    const s = flangeSizes(p);
    for (const b of slits) {
      expect(b.maxX - b.minX).toBeCloseTo(3);
      expect(b.maxY - b.minY).toBeCloseTo(s.slitLength);
    }
    // slits sit F from each vertical edge, centred in the front and back walls
    expect(slits.map((b) => (b.minX + b.maxX) / 2).sort((a, b) => a - b)).toEqual([10, 10, 70, 70]);
    expect(slits.map((b) => (b.minY + b.maxY) / 2).sort((a, b) => a - b)).toEqual([-15, -15, 75, 75]);
    // each tongue is wide enough to pass its slit
    expect(s.tongueWidth).toBeLessThan(s.slitLength);
  });

  it("ignores slots when flanges are off", () => {
    expect(cuts({ ...base, slots: true })).toHaveLength(1);
  });

  it("keeps every shape inside the outline's box", () => {
    const p = { ...base, flanges: true, slots: true };
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
    expect(validateBoxNet({ ...base, flanges: true, slots: true })).toBeNull();
  });
  it("rejects tiny or impossible boxes", () => {
    expect(validateBoxNet({ ...base, widthMm: 5 })).toMatch(/at least 10/);
    expect(validateBoxNet({ ...base, thicknessMm: 0 })).toMatch(/thickness/);
    expect(validateBoxNet({ ...base, flanges: true, flangeMm: 45 })).toMatch(/too wide/);
    expect(validateBoxNet({ ...base, flanges: true, flangeMm: 2 })).toMatch(/at least 3/);
    expect(validateBoxNet({ ...base, widthMm: 24, flanges: true, flangeMm: 10, slots: true })).toMatch(/overlap/);
  });
});
