import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { toDXF, toSVG } from "../src/export";
import { IDENTITY, boundsOf, circle, rectangle, transformPath, translation } from "../src/geometry";

describe("geometry", () => {
  it("transforms without mutating source", () => {
    const r = rectangle(10, 20);
    const t = transformPath(r, translation(5, 5));
    expect(r.start).toEqual({ x: 0, y: 0 });
    expect(t.start).toEqual({ x: 5, y: 5 });
  });
  it("keeps circles as arcs under uniform scale, flattens under non-uniform", () => {
    expect(transformPath(circle(5), [2, 0, 0, 2, 0, 0]).segs.every((s) => s.t === "a")).toBe(true);
    expect(transformPath(circle(5), [2, 0, 0, 1, 0, 0]).segs.every((s) => s.t === "c")).toBe(true);
  });
  it("circle bounds are +-r", () => {
    const b = boundsOf(circle(5));
    expect(b.minX).toBeCloseTo(-5, 1);
    expect(b.maxY).toBeCloseTo(5, 1);
  });
});

describe("doc", () => {
  it("undo/redo restores matrices", () => {
    const d = new Doc();
    const o = d.add(rectangle(10, 10), IDENTITY);
    d.checkpoint();
    d.transform(o.id, translation(7, 0));
    expect(d.get(o.id)!.matrix[4]).toBe(7);
    d.undo();
    expect(d.get(o.id)!.matrix[4]).toBe(0);
    d.redo();
    expect(d.get(o.id)!.matrix[4]).toBe(7);
  });
});

describe("export", () => {
  const d = new Doc();
  d.add(rectangle(10, 20), translation(5, 5), "cut");
  d.add(circle(3), translation(10, 15), "score");

  it("DXF has layers, mm units, lines and arcs", () => {
    const dxf = toDXF(d.state.objects);
    expect(dxf).toContain("$INSUNITS\n70\n4");
    expect((dxf.match(/\nLINE\n/g) ?? []).length).toBe(4);
    expect((dxf.match(/\nARC\n/g) ?? []).length).toBe(2);
    expect(dxf).toContain("8\nCUT");
    expect(dxf).toContain("8\nSCORE");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
  });
  it("SVG is in mm with Y flipped and layers coloured", () => {
    const svg = toSVG(d.state.objects);
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('stroke="#0000ff"');
    expect(svg).toContain("M5 -5L15 -5L15 -25L5 -25Z");
    expect(svg).toMatch(/width="\d+(\.\d+)?mm"/);
  });
});
