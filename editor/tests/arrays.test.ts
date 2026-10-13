import { describe, expect, it } from "vitest";
import { MAX_COPIES, circularMatrices, circularStep, linearOffsets, mirrorMatrix, validateCircular, validateLinear } from "../src/arrays";
import { apply, boundsOf, circle, rectangle, transformPath, translation, type Matrix } from "../src/geometry";

const b = { minX: 10, maxX: 30, minY: 100, maxY: 110 }; // 20 wide, 10 tall
const near = (a: { x: number; y: number }, x: number, y: number) => { expect(a.x).toBeCloseTo(x, 9); expect(a.y).toBeCloseTo(y, 9); };

describe("linearOffsets", () => {
  it("a 3 x 2 grid makes 5 copies on the right pitch (width + gap, height + gap)", () => {
    const o = linearOffsets(b, { countX: 3, countY: 2, gapX: 5, gapY: 2, rowShiftMm: 0 });
    expect(o.length).toBe(5);
    expect(o).toContainEqual({ x: 25, y: 0 });
    expect(o).toContainEqual({ x: 50, y: 0 });
    expect(o).toContainEqual({ x: 0, y: 12 });
    expect(o).toContainEqual({ x: 50, y: 12 });
    expect(o).not.toContainEqual({ x: 0, y: 0 }); // the original is not duplicated
  });
  it("one direction only", () => {
    expect(linearOffsets(b, { countX: 4, countY: 1, gapX: 0, gapY: 0, rowShiftMm: 0 }).map((q) => q.x)).toEqual([20, 40, 60]);
  });
  it("a row shift staggers each further row (bricks)", () => {
    const o = linearOffsets(b, { countX: 2, countY: 3, gapX: 0, gapY: 0, rowShiftMm: 10 });
    expect(o).toContainEqual({ x: 10, y: 10 }); // row 1, column 0
    expect(o).toContainEqual({ x: 30, y: 10 });
    expect(o).toContainEqual({ x: 20, y: 20 }); // row 2 is shifted twice
  });
  it("negative gaps overlap, and the grid goes up and to the right", () => {
    const o = linearOffsets(b, { countX: 2, countY: 1, gapX: -5, gapY: 0, rowShiftMm: 0 });
    expect(o).toEqual([{ x: 15, y: 0 }]);
  });
});

describe("validateLinear", () => {
  const ok = { countX: 2, countY: 2, gapX: 1, gapY: 1, rowShiftMm: 0 };
  it("accepts good values and explains bad ones", () => {
    expect(validateLinear(ok)).toBeNull();
    expect(validateLinear({ ...ok, countX: 1, countY: 1 })).toMatch(/at least 2/);
    expect(validateLinear({ ...ok, countX: 0 })).toMatch(/whole numbers/);
    expect(validateLinear({ ...ok, countX: 2.5 })).toMatch(/whole numbers/);
    expect(validateLinear({ ...ok, countX: 100, countY: 100 })).toMatch(/more than/);
    expect(validateLinear({ ...ok, gapX: NaN })).toMatch(/numbers/);
    expect(MAX_COPIES).toBeGreaterThan(100);
  });
});

describe("circular array", () => {
  const centre = { x: 20, y: 50 }; // 55 below the shape's centre (20,105)
  const full = { count: 4, sweepDeg: 360, centre, rotate: true };

  it("a full turn is split evenly: 4 shapes -> 90 degrees apart, none on the original", () => {
    expect(circularStep(full)).toBe(90);
    const m = circularMatrices(b, full);
    expect(m.length).toBe(3);
    const mid = { x: 20, y: 105 };
    near(apply(m[0]!, mid), 20 - 55, 50); // 90 degrees counter-clockwise: the offset (0,55) becomes (-55,0)
  });

  it("a partial sweep ends exactly on the last copy", () => {
    expect(circularStep({ count: 3, sweepDeg: 180 })).toBe(90);
    const m = circularMatrices(b, { count: 3, sweepDeg: 180, centre, rotate: true });
    near(apply(m[1]!, { x: 20, y: 105 }), 20, 50 - 55); // half a turn: directly opposite
  });

  it("every copy stays the same distance from the centre", () => {
    for (const mtx of circularMatrices(b, { ...full, count: 7 })) {
      const q = apply(mtx, { x: 20, y: 105 });
      expect(Math.hypot(q.x - centre.x, q.y - centre.y)).toBeCloseTo(55, 9);
    }
  });

  it("rotate: true turns each copy; rotate: false only moves it", () => {
    const turned = circularMatrices(b, { ...full, rotate: true })[0]!;
    const kept = circularMatrices(b, { ...full, rotate: false })[0]!;
    const r = transformPath(rectangle(20, 10), turned);
    expect(boundsOf(r).maxX - boundsOf(r).minX).toBeCloseTo(10, 9); // a 90 degree turn swaps width and height
    expect(kept.slice(0, 4)).toEqual([1, 0, 0, 1]); // pure translation
    const k = transformPath(rectangle(20, 10), kept as Matrix);
    expect(boundsOf(k).maxX - boundsOf(k).minX).toBeCloseTo(20, 9);
    // both put the shape's centre at the same place
    const mid = { x: 20, y: 105 };
    const a = apply(turned, mid), c = apply(kept, mid);
    near(c, a.x, a.y);
  });

  it("negative sweeps go clockwise", () => {
    const m = circularMatrices(b, { count: 2, sweepDeg: -90, centre, rotate: true });
    near(apply(m[0]!, { x: 20, y: 105 }), 20 + 55, 50); // clockwise: (0,55) becomes (+55,0)
  });

  it("circles stay true arcs when copies are rotated", () => {
    const m = circularMatrices({ minX: -5, maxX: 5, minY: -5, maxY: 5 }, { count: 3, sweepDeg: 360, centre: { x: 0, y: -30 }, rotate: true })[0]!;
    expect(transformPath(circle(5), m).segs.every((s) => s.t === "a")).toBe(true);
  });
});

describe("validateCircular", () => {
  const ok = { count: 6, sweepDeg: 360, centre: { x: 0, y: 0 }, rotate: true };
  it("accepts good values and explains bad ones", () => {
    expect(validateCircular(ok)).toBeNull();
    expect(validateCircular({ ...ok, count: 1 })).toMatch(/at least 2/);
    expect(validateCircular({ ...ok, sweepDeg: 0 })).toMatch(/sweep/);
    expect(validateCircular({ ...ok, sweepDeg: 400 })).toMatch(/sweep/);
    expect(validateCircular({ ...ok, centre: { x: NaN, y: 0 } })).toMatch(/centre/);
  });
});

describe("mirrorMatrix", () => {
  it("flips in place about the shape's own centre", () => {
    const h = mirrorMatrix(b, "h");
    near(apply(h, { x: 10, y: 100 }), 30, 100); // left edge goes to the right edge, same height
    near(apply(h, { x: 20, y: 105 }), 20, 105); // the centre doesn't move
    const v = mirrorMatrix(b, "v");
    near(apply(v, { x: 10, y: 100 }), 10, 110);
  });
  it("keeps the bounds where they were", () => {
    const r = transformPath(transformPath(rectangle(20, 10), translation(10, 100)), mirrorMatrix(b, "h"));
    expect(boundsOf(r)).toEqual(b);
  });
  it("keeps true arcs and is its own inverse", () => {
    const m = mirrorMatrix(b, "h");
    expect(transformPath(circle(5), m).segs.every((s) => s.t === "a")).toBe(true);
    const twice = transformPath(transformPath(rectangle(20, 10), translation(10, 100)), m);
    expect(boundsOf(transformPath(twice, m))).toEqual(b);
  });
});
