import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { anchorPoint, deltaToAnchor, selectionBounds, type Anchor } from "../src/anchor";
import { boundsOf, circle, rectangle, translation } from "../src/geometry";

const b = { minX: 10, maxX: 30, minY: 100, maxY: 140 }; // 20 wide, 40 tall

describe("anchorPoint (Y-up)", () => {
  const at = (col: 0 | 1 | 2, row: 0 | 1 | 2) => anchorPoint(b, { col, row } as Anchor);
  it("covers all 9 points", () => {
    expect(at(0, 0)).toEqual({ x: 10, y: 140 }); // top-left
    expect(at(1, 0)).toEqual({ x: 20, y: 140 });
    expect(at(2, 0)).toEqual({ x: 30, y: 140 });
    expect(at(0, 1)).toEqual({ x: 10, y: 120 });
    expect(at(1, 1)).toEqual({ x: 20, y: 120 }); // centre
    expect(at(2, 1)).toEqual({ x: 30, y: 120 });
    expect(at(0, 2)).toEqual({ x: 10, y: 100 }); // bottom-left
    expect(at(1, 2)).toEqual({ x: 20, y: 100 });
    expect(at(2, 2)).toEqual({ x: 30, y: 100 });
  });
});

describe("deltaToAnchor", () => {
  it("moves the chosen anchor to the typed position", () => {
    expect(deltaToAnchor(b, { col: 1, row: 1 }, { x: 50, y: 50 })).toEqual({ x: 30, y: -70 });
  });
  it("changes only the axis given", () => {
    expect(deltaToAnchor(b, { col: 2, row: 0 }, { x: 100 })).toEqual({ x: 70, y: 0 });
    expect(deltaToAnchor(b, { col: 2, row: 0 }, { y: 0 })).toEqual({ x: 0, y: -140 });
  });
});

describe("selectionBounds", () => {
  it("unions the bounds of the selected objects in bed space", () => {
    const d = new Doc();
    const a = d.add(rectangle(10, 10), translation(0, 0)).id;
    const c = d.add(rectangle(10, 10), translation(30, 20)).id;
    d.add(rectangle(10, 10), translation(500, 500));
    expect(selectionBounds(d.state.objects, [a, c])).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 30 });
    expect(selectionBounds(d.state.objects, [])).toBeNull();
  });
  it("moving by the delta lands the anchor exactly", () => {
    const d = new Doc();
    const id = d.add(circle(5), translation(60, 25)).id;
    const bounds = selectionBounds(d.state.objects, [id])!;
    const delta = deltaToAnchor(bounds, { col: 1, row: 1 }, { x: 100, y: 200 });
    d.transform(id, translation(delta.x, delta.y));
    const after = selectionBounds(d.state.objects, [id])!;
    expect((after.minX + after.maxX) / 2).toBeCloseTo(100, 9);
    expect((after.minY + after.maxY) / 2).toBeCloseTo(200, 9);
  });
});

describe("exact arc bounds", () => {
  it("a circle is exactly +-r, not off by the flattening tolerance", () => {
    const bb = boundsOf(circle(5));
    expect(bb).toEqual({ minX: -5, maxX: 5, minY: -5, maxY: 5 });
  });
});
