import { describe, expect, it } from "vitest";
import { DEFAULT_TRACE, blackShare, dropSmall, fitPixels, luma, parsePathData, potraceOptions, toBlackWhite, toDesign } from "../src/imagetrace";
import { startWidth } from "../src/imagetraceui";
import { boundsOf } from "../src/geometry";

const px = (...rgba: number[]) => ({ width: rgba.length / 4, height: 1, data: new Uint8ClampedArray(rgba) });

describe("black and white", () => {
  it("counts transparent pixels as white paper", () => {
    expect(luma(0, 0, 0, 0)).toBe(255);
    expect(luma(0, 0, 0, 255)).toBe(0);
    expect(luma(255, 255, 255, 255)).toBeCloseTo(255);
  });
  it("traces the dark parts, or the light ones when inverted", () => {
    const img = px(10, 10, 10, 255, 240, 240, 240, 255, 0, 0, 0, 0);
    const bw = toBlackWhite(img, 128, false);
    expect([bw.data[0], bw.data[4], bw.data[8]]).toEqual([0, 255, 255]); // dark -> traced; light and clear -> not
    const inv = toBlackWhite(img, 128, true);
    expect([inv.data[0], inv.data[4], inv.data[8]]).toEqual([255, 0, 0]);
    expect(blackShare(bw)).toBeCloseTo(1 / 3);
  });
  it("the threshold decides", () => {
    const grey = px(100, 100, 100, 255);
    expect(blackShare(toBlackWhite(grey, 128, false))).toBe(1);
    expect(blackShare(toBlackWhite(grey, 90, false))).toBe(0);
  });
  it("shrinks big pictures, never grows small ones", () => {
    expect(fitPixels(4000, 2000)).toEqual({ width: 1200, height: 600 });
    expect(fitPixels(300, 200)).toEqual({ width: 300, height: 200 });
  });
});

describe("Potrace's path data", () => {
  it("reads Potrace's relative lines (the lowercase l it really writes)", () => {
    const [p] = parsePathData("M2000 1600 l0 -200 400 0 400 0 0 200 0 200 -400 0 -400 0 0 -200z");
    expect(p!.closed).toBe(true);
    expect(p!.start).toEqual({ x: 2000, y: 1600 });
    expect(p!.segs).toHaveLength(8);
    const b = boundsOf(p!);
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([2000, 1400, 2800, 1800]);
  });
  it("reads relative and absolute curves, h/v lines, several paths and implicit repeats", () => {
    const ps = parsePathData("M0 0 c1 0 2 1 2 2 s0 0 0 0 M10 10 L20 10 H30 V20 C30 25 25 30 20 30 Z m5 5 l1 1");
    expect(ps).toHaveLength(3);
    expect(ps[0]!.closed).toBe(false);
    expect(ps[0]!.segs[0]).toEqual({ t: "c", c1: { x: 1, y: 0 }, c2: { x: 2, y: 1 }, to: { x: 2, y: 2 } });
    expect(ps[1]!.closed).toBe(true);
    expect(ps[1]!.segs.map((s) => s.to)).toEqual([{ x: 20, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 20, y: 30 }]);
    expect(ps[2]!.start).toEqual({ x: 15, y: 15 }); // m after z is relative to the start of the closed path (10,10)
  });
  it("gives nothing for nothing", () => {
    expect(parsePathData("")).toEqual([]);
    expect(parsePathData("M1 1")).toEqual([]);
  });
});

describe("sizing the result", () => {
  const sq = parsePathData("M0 0 l100 0 0 100 -100 0z");
  it("scales to mm from the origin", () => {
    const [p] = toDesign(sq, 0.5);
    const b = boundsOf(p!);
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 50, 50]);
  });
  it("drops shapes too small in both directions", () => {
    const tiny = toDesign(parsePathData("M0 0 l5 0 0 5 -5 0z"), 0.1); // 0.5 mm
    const thin = toDesign(parsePathData("M0 0 l500 0 0 5 -500 0z"), 0.1); // 50 x 0.5 mm: long enough to cut
    expect(dropSmall([...tiny, ...thin], 1)).toEqual(thin);
  });
  it("starts as wide as 60% of the bed, but within the bed's height too", () => {
    expect(startWidth({ width: 100, height: 100, data: new Uint8ClampedArray(0) }, 400, 400)).toBe(240 > 200 ? 200 : 240);
    expect(startWidth({ width: 100, height: 100, data: new Uint8ClampedArray(0) }, 400, 100)).toBe(60);
    expect(startWidth({ width: 100, height: 100, data: new Uint8ClampedArray(0) }, 10, 10)).toBe(10);
  });
  it("maps our settings to Potrace's", () => {
    expect(potraceOptions({ ...DEFAULT_TRACE, specks: 7.4, smoothing: 5 })).toMatchObject({ turdsize: 7, alphamax: 1.34, pathonly: true, extractcolors: false });
    expect(potraceOptions({ ...DEFAULT_TRACE, smoothing: -1 }).alphamax).toBe(0);
  });
});
