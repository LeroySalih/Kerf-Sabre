import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { toDXF } from "../src/export";
import { boundsOf, circle, rectangle, transformPath, translation } from "../src/geometry";
import { designMin, layerFor, mmPerUnit, parseDXF, scalePath } from "../src/dxf-import";

const dxf = (entities: string, header = "") =>
  `0\nSECTION\n2\nHEADER\n${header}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;

describe("DXF import", () => {
  it("round-trips our own export (lines + arcs, layers, mm)", () => {
    const d = new Doc();
    d.add(rectangle(10, 20), translation(5, 5), "cut");
    d.add(circle(3), translation(10, 15), "score");
    const r = parseDXF(toDXF(d.state.objects));
    expect(r.insunits).toBe(4);
    expect(r.shapes.length).toBe(4 + 2); // 4 LINEs + 2 ARCs, unjoined (joining is Server work)
    expect(r.shapes.filter((s) => s.layer === "score").length).toBe(2);
  });

  it("reads units and converts inches", () => {
    const r = parseDXF(dxf("0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n0\n", "9\n$INSUNITS\n70\n1\n"));
    expect(mmPerUnit(r.insunits)).toBe(25.4);
    expect(scalePath(r.shapes[0]!.path, 25.4).segs[0]).toEqual({ t: "l", to: { x: 25.4, y: 0 } });
  });

  it("reports missing units as null", () => {
    expect(parseDXF(dxf("0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n5\n")).insunits).toBeNull();
    expect(mmPerUnit(null)).toBeNull();
  });

  it("parses CIRCLE as two true arcs and ARC as ccw", () => {
    const c = parseDXF(dxf("0\nCIRCLE\n8\n0\n10\n10\n20\n10\n40\n5\n")).shapes[0]!.path;
    expect(c.closed && c.segs.every((s) => s.t === "a")).toBe(true);
    const a = parseDXF(dxf("0\nARC\n8\n0\n10\n0\n20\n0\n40\n10\n50\n0\n51\n90\n")).shapes[0]!.path;
    expect(a.start.x).toBeCloseTo(10);
    const e = a.segs[0]!;
    expect(e.t === "a" && e.to.y).toBeCloseTo(10);
  });

  it("LWPOLYLINE with a bulge makes a true arc (semicircle)", () => {
    // (0,0) -> (10,0) with bulge 1 = 180 degree ccw arc bulging below the chord
    const p = parseDXF(dxf("0\nLWPOLYLINE\n8\n0\n70\n0\n90\n2\n10\n0\n20\n0\n42\n1\n10\n10\n20\n0\n")).shapes[0]!.path;
    const s = p.segs[0]!;
    expect(s.t).toBe("a");
    if (s.t === "a") { expect(s.c.x).toBeCloseTo(5); expect(s.c.y).toBeCloseTo(0); expect(s.ccw).toBe(true); }
    expect(boundsOf(p).minY).toBeCloseTo(-5, 1);
  });

  it("closed LWPOLYLINE rectangle", () => {
    const p = parseDXF(dxf("0\nLWPOLYLINE\n8\n0\n70\n1\n90\n4\n10\n0\n20\n0\n10\n4\n20\n0\n10\n4\n20\n3\n10\n0\n20\n3\n")).shapes[0]!.path;
    expect(p.closed).toBe(true);
    expect(p.segs.length).toBe(4);
  });

  it("evaluates a SPLINE within its control hull", () => {
    const spline = "0\nSPLINE\n8\n0\n70\n8\n71\n3\n" + [0, 0, 0, 0, 1, 1, 1, 1].map((k) => `40\n${k}\n`).join("") +
      [[0, 0], [1, 2], [3, 2], [4, 0]].map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("");
    const p = parseDXF(dxf(spline)).shapes[0]!.path;
    const b = boundsOf(p);
    expect(p.start).toEqual({ x: 0, y: 0 });
    expect(b.maxX).toBeCloseTo(4, 1);
    expect(b.maxY).toBeGreaterThan(1);
    expect(b.maxY).toBeLessThanOrEqual(2);
  });

  it("counts unsupported entities instead of failing", () => {
    expect(parseDXF(dxf("0\nHATCH\n8\n0\n0\nTEXT\n8\n0\n")).skipped).toEqual({ HATCH: 1, TEXT: 1 });
  });

  it("assigns layers by name or colour, defaulting to Cut", () => {
    expect(layerFor("SCORE", null)).toBe("score");
    expect(layerFor("0", 5)).toBe("score");
    expect(layerFor("0", null)).toBe("cut");
  });

  it("designMin gives the bounding-box bottom-left", () => {
    const m = designMin([transformPath(rectangle(5, 5), translation(3, 4))]);
    expect(m).toEqual({ x: 3, y: 4 });
  });
});
