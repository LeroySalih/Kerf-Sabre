import { describe, expect, it } from "vitest";
import { boundsOf, flatten } from "../src/geometry";
import { cellCount, fingerBox, fingerBoxPanels, validateFingerBox, type FingerBoxParams } from "../src/fingerbox";
import type { Point } from "../src/coords";

const open: FingerBoxParams = { widthMm: 100, depthMm: 70, heightMm: 40, thicknessMm: 3, fingerMm: 9, lid: false };
const closed: FingerBoxParams = { ...open, lid: true };

const inside = (pt: Point, poly: Point[]): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

/** How many panels contain the 3D point? Each panel is a t-thick slab whose 2D outline is in the plane. */
function owners(p: FingerBoxParams, x: number, y: number, z: number): number {
  const { widthMm: W, depthMm: D, heightMm: H, thicknessMm: t } = p;
  const polys = new Map(fingerBoxPanels(p).map((q) => [q.name, flatten(q.path, 0.01)]));
  let n = 0;
  const hit = (name: string, slab: boolean, u: number, v: number) => { if (slab && polys.has(name as never) && inside({ x: u, y: v }, polys.get(name as never)!)) n++; };
  hit("base", z < t, x, y);
  hit("lid", z > H - t, x, y);
  hit("front", y < t, x, z);
  hit("back", y > D - t, x, z);
  hit("left", x < t, y, z);
  hit("right", x > W - t, y, z);
  return n;
}

describe("cellCount", () => {
  it("is always odd and at least 1", () => {
    for (const len of [1, 10, 25, 58, 94, 100]) for (const target of [3, 5, 9, 12]) {
      const n = cellCount(len, target);
      expect(n % 2).toBe(1);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("fingerBoxPanels", () => {
  it("makes five panels for an open box and six with a lid", () => {
    expect(fingerBoxPanels(open).map((q) => q.name)).toEqual(["base", "front", "back", "left", "right"]);
    expect(fingerBoxPanels(closed).map((q) => q.name)).toEqual(["base", "lid", "front", "back", "left", "right"]);
  });

  it("gives every panel its full footprint and a closed outline", () => {
    for (const q of fingerBoxPanels(closed)) {
      expect(q.path.closed).toBe(true);
      expect(boundsOf(q.path)).toMatchObject({ minX: 0, minY: 0, maxX: q.w, maxY: q.h });
    }
  });

  for (const [label, p] of [["open", open], ["closed", closed], ["thick, wide fingers", { ...closed, thicknessMm: 6, fingerMm: 20 }]] as const) {
    it(`every point of the ${label} box shell is in exactly one panel, and the cavity in none`, () => {
      const { widthMm: W, depthMm: D, heightMm: H, thicknessMm: t } = p;
      let shell = 0;
      for (let x = 0.31; x < W; x += 1.7) for (let y = 0.29; y < D; y += 1.9) for (let z = 0.37; z < H; z += 1.3) {
        const wantShell = x < t || x > W - t || y < t || y > D - t || z < t || (p.lid && z > H - t);
        const n = owners(p, x, y, z);
        if (wantShell) { shell++; if (n !== 1) throw new Error(`shell point ${x},${y},${z} is in ${n} panels`); }
        else if (n !== 0) throw new Error(`cavity point ${x},${y},${z} is in ${n} panels`);
      }
      expect(shell).toBeGreaterThan(100);
    });
  }
});

describe("fingerBox layout", () => {
  it("returns every panel as a Cut shape, none overlapping another's box", () => {
    const items = fingerBox(closed);
    expect(items).toHaveLength(6);
    expect(items.every((i) => i.layer === "cut" && i.path.closed)).toBe(true);
    const bs = items.map((i) => boundsOf(i.path));
    for (let a = 0; a < bs.length; a++) for (let b = a + 1; b < bs.length; b++) {
      const A = bs[a]!, B = bs[b]!;
      expect(A.maxX <= B.minX || B.maxX <= A.minX || A.maxY <= B.minY || B.maxY <= A.minY).toBe(true);
    }
  });
});

describe("validateFingerBox", () => {
  it("accepts a sensible box", () => expect(validateFingerBox(open)).toBeNull());
  it("rejects bad inputs", () => {
    expect(validateFingerBox({ ...open, thicknessMm: 0 })).toMatch(/thickness/);
    expect(validateFingerBox({ ...open, fingerMm: 2 })).toMatch(/Fingers/);
    expect(validateFingerBox({ ...open, heightMm: 10 })).toMatch(/at least/);
  });
});
