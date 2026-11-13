import { describe, expect, it } from "vitest";
import { explainIssue, scaleChoices, sizeIssue, sizeLabel, sizeOfBounds, suggestedChoice } from "../src/importscale";

describe("is the imported model a sensible size?", () => {
  it("flags a longest side under 10 mm or over 400 mm, and nothing in between", () => {
    expect(sizeIssue({ w: 9.9, h: 5 })).toBe("small");
    expect(sizeIssue({ w: 10, h: 1 })).toBeNull(); // 10 is allowed
    expect(sizeIssue({ w: 400, h: 400 })).toBeNull(); // 40 cm is allowed
    expect(sizeIssue({ w: 400.1, h: 20 })).toBe("large");
    expect(sizeIssue({ w: 5, h: 250 })).toBeNull(); // a thin part is fine: it is the longest side that counts
    expect(sizeIssue({ w: 2000, h: 1500 })).toBe("large");
  });
  it("measures the combined bounding box", () => {
    expect(sizeOfBounds([{ minX: 0, minY: 0, maxX: 10, maxY: 5 }, { minX: 20, minY: -5, maxX: 30, maxY: 1 }])).toEqual({ w: 30, h: 10 });
    expect(sizeOfBounds([])).toBeNull();
  });
});

describe("the choices and the sizes they give", () => {
  it("gives the new size for mm -> cm (divide by 10) and cm -> mm (multiply by 10)", () => {
    const c = scaleChoices({ w: 1200, h: 800 });
    expect(c.map((x) => x.id)).toEqual(["keep", "mm-to-cm", "cm-to-mm"]);
    expect(c[1]!.size).toEqual({ w: 120, h: 80 });
    expect(c[2]!.size).toEqual({ w: 12000, h: 8000 });
    expect(c[1]!.label).toContain("120 × 80 mm");
    expect(c[0]!.label).toContain("1200 × 800 mm");
  });
  it("says which choices bring the size into range", () => {
    const c = scaleChoices({ w: 1200, h: 800 });
    expect(c.map((x) => x.fixes)).toEqual([false, true, false]);
    const tiny = scaleChoices({ w: 8, h: 5 });
    expect(tiny.map((x) => x.fixes)).toEqual([false, false, true]);
  });
  it("preselects the fix that points the right way, or keeps if it would not help", () => {
    expect(suggestedChoice({ w: 1200, h: 800 })).toBe("mm-to-cm");
    expect(suggestedChoice({ w: 8, h: 5 })).toBe("cm-to-mm");
    expect(suggestedChoice({ w: 100, h: 50 })).toBe("keep");
    expect(suggestedChoice({ w: 50000, h: 100 })).toBe("keep"); // 5000 mm after dividing: still too big
    expect(suggestedChoice({ w: 0.5, h: 0.2 })).toBe("keep"); // 5 mm after multiplying: still too small
  });
  it("formats sizes briefly", () => {
    expect(sizeLabel({ w: 12.345, h: 8 })).toBe("12.3 × 8 mm");
    expect(sizeLabel({ w: 1234.6, h: 800.2 })).toBe("1235 × 800 mm");
  });
  it("explains the problem and how the units were read", () => {
    expect(explainIssue({ w: 1200, h: 800 }, { unitsInFile: null })).toMatch(/1200 × 800 mm.*bigger than 40 cm.*read as centimetres/);
    expect(explainIssue({ w: 8, h: 5 }, { unitsInFile: "millimetres" })).toMatch(/smaller than 10 mm.*millimetres/);
  });
});
