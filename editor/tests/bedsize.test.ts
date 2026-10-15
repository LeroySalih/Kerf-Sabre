import { describe, expect, it } from "vitest";
import { bedChoices, bedText, commonBed, fitsAnyLaser, parseBed, validateBed } from "../src/bedsize";

const beds = [{ widthMm: 400, heightMm: 415 }, { widthMm: 355, heightMm: 390 }, { widthMm: 400, heightMm: 415 }];

describe("bed size", () => {
  it("starts from the size every laser can cut", () => {
    expect(commonBed(beds)).toEqual({ widthMm: 355, heightMm: 390 });
    expect(bedChoices(beds).map((c) => c.value)).toEqual(["common", "laser-0"]);
    expect(bedChoices(beds)[0]!.label).toBe("Fits every laser (355 × 390 mm)");
    expect(bedChoices(beds)[1]).toMatchObject({ label: "400 × 415 mm", bed: { widthMm: 400, heightMm: 415 } });
  });
  it("copes with one laser, or none", () => {
    expect(bedChoices([beds[0]!])).toHaveLength(1);
    expect(commonBed([])).toEqual({ widthMm: 400, heightMm: 400 });
  });
  it("formats sizes", () => expect(bedText({ widthMm: 300.004, heightMm: 200.5 })).toBe("300 × 200.5 mm"));
  it("validates a custom size", () => {
    expect(validateBed(300, 200)).toBeNull();
    expect(validateBed(10, 200)).toMatch(/between/);
    expect(validateBed(300, NaN)).toMatch(/between/);
    expect(validateBed(5000, 200)).toMatch(/between/);
  });
  it("only accepts a sensible remembered size", () => {
    expect(parseBed(JSON.stringify({ widthMm: 300, heightMm: 250 }))).toEqual({ widthMm: 300, heightMm: 250 });
    expect(parseBed("nonsense")).toBeNull();
    expect(parseBed(null)).toBeNull();
    expect(parseBed(JSON.stringify({ widthMm: 1, heightMm: 250 }))).toBeNull();
  });
  it("knows when a design is too big for every laser", () => {
    const outside = (items: number[], b: { widthMm: number }) => items.filter((w) => w > b.widthMm);
    expect(fitsAnyLaser([380], beds, outside)).toBe(true); // fits the 400 mm laser
    expect(fitsAnyLaser([450], beds, outside)).toBe(false);
    expect(fitsAnyLaser([450], [], outside)).toBe(true);
  });
});
