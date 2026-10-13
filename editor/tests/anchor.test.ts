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

import { scaleAboutAnchor } from "../src/anchor";
import { transformPath } from "../src/geometry";

describe("scaleAboutAnchor", () => {
  const setup = () => {
    const d = new Doc();
    const id = d.add(rectangle(20, 40), translation(10, 100)).id; // bounds 10..30 x 100..140
    return { d, id, bounds: selectionBounds(d.state.objects, [id])! };
  };
  const resize = (axis: "w" | "h", size: number, lock: boolean, anchor: Anchor) => {
    const { d, id, bounds } = setup();
    d.transform(id, scaleAboutAnchor(bounds, anchor, axis, size, lock)!);
    return { after: selectionBounds(d.state.objects, [id])!, anchorBefore: anchorPoint(bounds, anchor), d, id };
  };
  const BL: Anchor = { col: 0, row: 2 }, TR: Anchor = { col: 2, row: 0 }, C: Anchor = { col: 1, row: 1 };

  it("sets the width and keeps the anchor fixed", () => {
    for (const a of [BL, TR, C]) {
      const r = resize("w", 50, false, a);
      expect(r.after.maxX - r.after.minX).toBeCloseTo(50, 9);
      expect(r.after.maxY - r.after.minY).toBeCloseTo(40, 9); // height untouched
      const p = anchorPoint(r.after, a);
      expect(p.x).toBeCloseTo(r.anchorBefore.x, 9);
      expect(p.y).toBeCloseTo(r.anchorBefore.y, 9);
    }
  });

  it("sets the height and keeps the anchor fixed", () => {
    const r = resize("h", 10, false, TR);
    expect(r.after.maxY - r.after.minY).toBeCloseTo(10, 9);
    expect(r.after.maxX).toBeCloseTo(30, 9); // top-right anchor stays
    expect(r.after.maxY).toBeCloseTo(140, 9);
  });

  it("lock keeps the aspect ratio", () => {
    const r = resize("w", 40, true, C); // 20x40 -> 40x80
    expect(r.after.maxX - r.after.minX).toBeCloseTo(40, 9);
    expect(r.after.maxY - r.after.minY).toBeCloseTo(80, 9);
  });

  it("rejects non-positive sizes and zero-extent axes", () => {
    const { bounds } = setup();
    expect(scaleAboutAnchor(bounds, BL, "w", 0, false)).toBeNull();
    expect(scaleAboutAnchor(bounds, BL, "w", -5, false)).toBeNull();
    expect(scaleAboutAnchor({ ...bounds, maxY: bounds.minY }, BL, "h", 10, false)).toBeNull(); // flat line
  });

  it("locked scaling keeps circles as true arcs; unlocked turns them into curves", () => {
    const c = circle(5);
    const bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 };
    const locked = transformPath(c, scaleAboutAnchor(bounds, C, "w", 20, true)!);
    expect(locked.segs.every((s) => s.t === "a")).toBe(true);
    const free = transformPath(c, scaleAboutAnchor(bounds, C, "w", 20, false)!);
    expect(free.segs.every((s) => s.t === "c")).toBe(true);
    const fb = boundsOf(free);
    expect(fb.maxX - fb.minX).toBeCloseTo(20, 1);
    expect(fb.maxY - fb.minY).toBeCloseTo(10, 1);
  });
});

import { rotateAboutAnchor, scaleBy } from "../src/anchor";
import { apply } from "../src/geometry";

describe("scaleBy", () => {
  const bb = { minX: 10, maxX: 30, minY: 100, maxY: 140 };
  it("200% about top-right doubles the size and keeps that corner", () => {
    const m = scaleBy(bb, { col: 2, row: 0 }, 2, 2)!;
    expect(apply(m, { x: 30, y: 140 })).toEqual({ x: 30, y: 140 });
    expect(apply(m, { x: 10, y: 100 })).toEqual({ x: -10, y: 60 });
  });
  it("scales axes independently", () => {
    const m = scaleBy(bb, { col: 0, row: 2 }, 0.5, 3)!;
    expect(apply(m, { x: 30, y: 140 })).toEqual({ x: 20, y: 220 });
  });
  it("rejects zero, negative and non-finite factors", () => {
    for (const f of [0, -1, NaN, Infinity]) expect(scaleBy(bb, { col: 1, row: 1 }, f, 1)).toBeNull();
  });
});

describe("rotateAboutAnchor", () => {
  const bb = { minX: 10, maxX: 30, minY: 100, maxY: 140 }; // centre (20,120)
  const near = (p: { x: number; y: number }, x: number, y: number) => {
    expect(p.x).toBeCloseTo(x, 9);
    expect(p.y).toBeCloseTo(y, 9);
  };
  it("+90 is counter-clockwise: a point right of the anchor moves above it", () => {
    const m = rotateAboutAnchor(bb, { col: 1, row: 1 }, 90)!;
    near(apply(m, { x: 30, y: 120 }), 20, 130);
  });
  it("keeps the anchor point fixed for every anchor", () => {
    for (const col of [0, 1, 2] as const)
      for (const row of [0, 1, 2] as const) {
        const a = { col, row };
        const p = anchorPoint(bb, a);
        near(apply(rotateAboutAnchor(bb, a, 37)!, p), p.x, p.y);
      }
  });
  it("90 degrees swaps width and height about the centre", () => {
    const d = new Doc();
    const id = d.add(rectangle(20, 40), translation(10, 100)).id;
    const b0 = selectionBounds(d.state.objects, [id])!;
    d.transform(id, rotateAboutAnchor(b0, { col: 1, row: 1 }, 90)!);
    const b1 = selectionBounds(d.state.objects, [id])!;
    expect(b1.maxX - b1.minX).toBeCloseTo(40, 9);
    expect(b1.maxY - b1.minY).toBeCloseTo(20, 9);
    expect((b1.minX + b1.maxX) / 2).toBeCloseTo(20, 9);
  });
  it("360 returns to the start, and circles stay true arcs", () => {
    const m = rotateAboutAnchor(bb, { col: 0, row: 2 }, 360)!;
    near(apply(m, { x: 30, y: 140 }), 30, 140);
    expect(transformPath(circle(5), rotateAboutAnchor(bb, { col: 1, row: 1 }, 33)!).segs.every((s) => s.t === "a")).toBe(true);
  });
  it("rejects non-finite angles", () => {
    expect(rotateAboutAnchor(bb, { col: 1, row: 1 }, NaN)).toBeNull();
  });
});
