import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { boxDimensions, dimGeometry, dimLabel, dimValue, pickDimension, radialFromPath, type LinearDim } from "../src/dimensions";
import { circle, rectangle, transformPath, translation } from "../src/geometry";
import { toDXF, toSVG } from "../src/export";
import { buildJob, fromJobDimension } from "../src/job";

const lin = (axis: LinearDim["axis"], a: [number, number], b: [number, number], offsetMm: number): LinearDim => ({ id: "d", kind: "linear", axis, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, offsetMm });

describe("values and labels", () => {
  it("aligned measures the true distance; horizontal and vertical measure one axis", () => {
    expect(dimValue(lin("aligned", [0, 0], [30, 40], 5))).toBeCloseTo(50);
    expect(dimValue(lin("horizontal", [0, 0], [30, 40], 5))).toBeCloseTo(30);
    expect(dimValue(lin("vertical", [0, 0], [30, 40], 5))).toBeCloseTo(40);
  });
  it("labels are plain mm, with diameter and radius marks", () => {
    expect(dimLabel(lin("horizontal", [0, 0], [123.456, 0], 5))).toBe("123.46");
    expect(dimLabel({ id: "r", kind: "radial", center: { x: 0, y: 0 }, radiusMm: 20, angleRad: 0, diameter: true })).toBe("Ø40");
    expect(dimLabel({ id: "r", kind: "radial", center: { x: 0, y: 0 }, radiusMm: 20, angleRad: 0, diameter: false })).toBe("R20");
  });
});

describe("geometry", () => {
  it("a horizontal dimension with a negative offset sits below the points", () => {
    const g = dimGeometry(lin("horizontal", [10, 20], [60, 20], -8));
    const line = g.lines[2]!;
    expect(line[0]).toEqual({ x: 10, y: 12 });
    expect(line[1]).toEqual({ x: 60, y: 12 });
    expect(g.labelAt).toEqual({ x: 35, y: 12 });
    // arrows point outwards to the extension lines
    expect(g.arrows[0]!.dir.x).toBeCloseTo(-1);
    expect(g.arrows[1]!.dir.x).toBeCloseTo(1);
  });
  it("the dimension line of a horizontal dimension is level even when the points are not", () => {
    const [p1, p2] = dimGeometry(lin("horizontal", [0, 0], [50, 30], 6)).lines[2]!;
    expect(p1.y).toBeCloseTo(p2.y);
    expect(p1.y).toBeCloseTo(36);
  });
  it("a diameter passes through the centre and has two arrows on the circle", () => {
    const g = dimGeometry({ id: "r", kind: "radial", center: { x: 50, y: 50 }, radiusMm: 10, angleRad: Math.PI / 2, diameter: true });
    expect(g.lines[0]![0].y).toBeCloseTo(40);
    expect(g.lines[0]![1].y).toBeCloseTo(60);
    expect(g.arrows).toHaveLength(2);
  });
  it("box dimensions are width under and height beside the box", () => {
    let n = 0;
    const dims = boxDimensions({ minX: 10, minY: 10, maxX: 70, maxY: 50 }, () => `d${++n}`);
    expect(dims.map((d) => dimValue(d))).toEqual([60, 40]);
    expect(dimGeometry(dims[0]!).labelAt.y).toBeCloseTo(2);
    expect(dimGeometry(dims[1]!).labelAt.x).toBeCloseTo(78);
  });
});

describe("picking and circles", () => {
  it("picks the nearest dimension within the tolerance", () => {
    const d = lin("horizontal", [0, 0], [50, 0], -10);
    expect(pickDimension([d], { x: 25, y: -10.5 }, 2)).toBe("d");
    expect(pickDimension([d], { x: 25, y: 5 }, 2)).toBeUndefined();
  });
  it("makes a diameter dimension from a click on a circle", () => {
    const path = transformPath(circle(12), translation(40, 30));
    const dim = radialFromPath(path, { x: 52.2, y: 30.1 }, 3, true, "x")!;
    expect(dim.center.x).toBeCloseTo(40);
    expect(dim.radiusMm).toBeCloseTo(12);
    expect(dimLabel(dim)).toBe("Ø24");
    expect(radialFromPath(path, { x: 0, y: 0 }, 3, true, "x")).toBeNull();
    expect(radialFromPath(transformPath(rectangle(10, 10), translation(0, 0)), { x: 5, y: 0 }, 3, true, "x")).toBeNull();
  });
});

describe("dimensions are annotations only", () => {
  it("are kept in the Doc with undo, but never appear in exports or the cutting job's objects", () => {
    const d = new Doc();
    d.add(rectangle(50, 30), translation(10, 10), "cut");
    const dxfBefore = toDXF(d.state.objects), svgBefore = toSVG(d.state.objects);
    d.checkpoint();
    d.addDimensions(boxDimensions({ minX: 10, minY: 10, maxX: 60, maxY: 40 }, () => d.newDimId()));
    expect(d.state.dimensions).toHaveLength(2);
    expect(toDXF(d.state.objects)).toBe(dxfBefore);
    expect(toSVG(d.state.objects)).toBe(svgBefore);
    const job = buildJob({ objects: d.state.objects, dimensions: d.state.dimensions, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false });
    expect(job.objects).toHaveLength(1);
    expect(job.dimensions).toHaveLength(2);
    expect(job.dimensions!.map(fromJobDimension)).toEqual(d.state.dimensions); // survives the trip to the server and back
    d.undo();
    expect(d.state.dimensions).toHaveLength(0);
  });
});

describe("saved with the job", () => {
  it("the shared job schema accepts them, and rejects a malformed one", () => {
    const schema = JSON.parse(readFileSync(new URL("../../shared/job.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({ strict: false, formats: { "date-time": true } }).compile(schema);
    const d = new Doc();
    d.add(rectangle(50, 30), translation(10, 10), "cut");
    d.addDimensions([...boxDimensions({ minX: 10, minY: 10, maxX: 60, maxY: 40 }, () => d.newDimId()), { id: "r", kind: "radial", center: { x: 1, y: 2 }, radiusMm: 3, angleRad: 0, diameter: false }]);
    const job = buildJob({ objects: d.state.objects, dimensions: d.state.dimensions, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false });
    expect(validate(job), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...job, dimensions: [{ id: "x", kind: "linear", axis: "diagonal", a: [0, 0], b: [1, 1], offsetMm: 1 }] })).toBe(false);
  });
});
