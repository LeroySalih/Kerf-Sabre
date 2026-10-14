import { describe, expect, it } from "vitest";
import { alignDeltas, distributeDeltas, unionBounds, type Unit } from "../src/align";

const u = (id: number, minX: number, minY: number, w: number, h: number): Unit => ({ ids: [id], bounds: { minX, minY, maxX: minX + w, maxY: minY + h } });

describe("alignDeltas", () => {
  const units = [u(1, 0, 0, 10, 10), u(2, 30, 20, 20, 5), u(3, 15, 50, 4, 40)];
  const ref = unionBounds(units); // x 0..50, y 0..90

  it("left / right line up on the reference edge", () => {
    expect(alignDeltas(units, "left", ref).map((d) => d.x)).toEqual([0, -30, -15]);
    expect(alignDeltas(units, "right", ref).map((d) => d.x)).toEqual([40, 0, 31]);
    expect(alignDeltas(units, "left", ref).every((d) => d.y === 0)).toBe(true);
  });

  it("top is the larger Y (bed space is Y-up); bottom is the smaller", () => {
    expect(alignDeltas(units, "top", ref).map((d) => d.y)).toEqual([80, 65, 0]);
    expect(alignDeltas(units, "bottom", ref).map((d) => d.y)).toEqual([0, -20, -50]);
  });

  it("centre and middle align the centres", () => {
    expect(alignDeltas(units, "centre", ref).map((d) => d.x)).toEqual([20, -15, 8]);
    expect(alignDeltas(units, "middle", ref).map((d) => d.y)).toEqual([40, 22.5, -25]);
  });

  it("works against any reference, e.g. a bed", () => {
    const bed = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    const d = alignDeltas([u(1, 5, 5, 10, 10)], "centre", bed);
    expect(d[0]!.x).toBe(190); // bed centre 200 minus the shape centre 10
    expect(alignDeltas([u(1, 5, 5, 10, 10)], "top", bed)[0]!.y).toBe(285);
  });
});

describe("distributeDeltas", () => {
  it("makes the gaps equal and keeps the outer two where they are", () => {
    const units = [u(1, 0, 0, 10, 5), u(2, 12, 0, 10, 5), u(3, 100, 0, 20, 5)]; // x: 0-10, 12-22, 100-120
    const d = distributeDeltas(units, "h");
    // span 120, widths 40 -> gap 40: 0-10, 50-60, 100-120
    expect(d.map((q) => q.x)).toEqual([0, 38, 0]);
    expect(d.every((q) => q.y === 0)).toBe(true);
  });

  it("is independent of the order the shapes were selected in", () => {
    const units = [u(3, 100, 0, 20, 5), u(1, 0, 0, 10, 5), u(2, 12, 0, 10, 5)];
    expect(distributeDeltas(units, "h").map((q) => q.x)).toEqual([0, 0, 38]);
  });

  it("distributes vertically", () => {
    const units = [u(1, 0, 0, 5, 10), u(2, 0, 11, 5, 10), u(3, 0, 60, 5, 10), u(4, 0, 90, 5, 10)];
    const d = distributeDeltas(units, "v");
    const ys = units.map((q, i) => q.bounds.minY + d[i]!.y);
    const gaps = [ys[1]! - (ys[0]! + 10), ys[2]! - (ys[1]! + 10), ys[3]! - (ys[2]! + 10)];
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 9);
    expect(ys[0]).toBe(0);
    expect(ys[3]).toBe(90);
  });

  it("needs three or more", () => {
    expect(distributeDeltas([u(1, 0, 0, 1, 1), u(2, 5, 0, 1, 1)], "h")).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });
});
