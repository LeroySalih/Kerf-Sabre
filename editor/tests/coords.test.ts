import { describe, expect, it } from "vitest";
import { bedToScreen, fitView, screenToBed, zoomAt } from "../src/coords";

describe("coords", () => {
  const view = { scale: 2, originPx: { x: 10, y: 500 } };

  it("flips Y: bed up is screen up", () => {
    expect(bedToScreen(view, { x: 0, y: 0 })).toEqual({ x: 10, y: 500 });
    expect(bedToScreen(view, { x: 5, y: 10 })).toEqual({ x: 20, y: 480 });
  });

  it("round-trips bed -> screen -> bed", () => {
    const p = { x: 123.4, y: 56.7 };
    const q = screenToBed(view, bedToScreen(view, p));
    expect(q.x).toBeCloseTo(p.x);
    expect(q.y).toBeCloseTo(p.y);
  });

  it("fitView centres the bed with origin bottom-left", () => {
    const v = fitView(400, 400, 1000, 800, 0);
    expect(v.scale).toBe(2);
    expect(bedToScreen(v, { x: 0, y: 0 })).toEqual({ x: 100, y: 800 });
    expect(bedToScreen(v, { x: 400, y: 400 })).toEqual({ x: 900, y: 0 });
  });

  it("zoomAt keeps the point under the cursor fixed", () => {
    const pt = { x: 300, y: 200 };
    const before = screenToBed(view, pt);
    const after = screenToBed(zoomAt(view, pt, 1.5), pt);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});

import { panBy } from "../src/coords";

describe("panBy", () => {
  const v = { scale: 2, originPx: { x: 10, y: 500 } };
  it("moves the bed with the drag and keeps the scale", () => {
    const p = panBy(v, 30, -20);
    expect(p.scale).toBe(2);
    expect(p.originPx).toEqual({ x: 40, y: 480 });
  });
  it("the bed point under the cursor follows the cursor", () => {
    const start = { x: 100, y: 100 };
    const before = screenToBed(v, start);
    const after = screenToBed(panBy(v, 50, 25), { x: start.x + 50, y: start.y + 25 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
