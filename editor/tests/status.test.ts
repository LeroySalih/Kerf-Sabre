import { describe, expect, it } from "vitest";
import { selectionSummary } from "../src/status";

describe("selectionSummary", () => {
  it("shows nothing selected", () => {
    expect(selectionSummary(0, null)).toBe("Nothing selected");
  });
  it("shows horizontal and vertical extent to 2 dp", () => {
    expect(selectionSummary(1, { minX: 10, maxX: 83.903, minY: 100, maxY: 144.3419 })).toBe(
      "1 object selected  |  Width 73.90 mm  |  Height 44.34 mm",
    );
  });
  it("pluralises", () => {
    expect(selectionSummary(3, { minX: 0, maxX: 5, minY: 0, maxY: 5 })).toBe("3 objects selected  |  Width 5.00 mm  |  Height 5.00 mm");
  });
});
