import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { circle, rectangle, translation } from "../src/geometry";
import { buildJob, toJobObject } from "../src/job";
import { pathLength } from "../src/tabs";
import { transformPath } from "../src/geometry";

const schema = JSON.parse(readFileSync(new URL("../../shared/job.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, formats: { "date-time": true } }).compile(schema);
const check = (j: unknown) => { expect(validate(j), JSON.stringify(validate.errors)).toBe(true); };

describe("buildJob", () => {
  it("produces a document the shared job schema accepts, with arcs and curves intact", () => {
    const d = new Doc();
    d.add(rectangle(50, 30), translation(10, 10), "cut");
    d.add(circle(5), translation(30, 25), "cut");
    d.add(rectangle(5, 5), translation(12, 12), "score");
    const job = buildJob({ objects: d.state.objects, pupilId: "P001", presetId: "ply-3mm", origin: { mode: "absolute" }, submit: true });
    check(job);
    expect(job.status).toBe("submitted");
    expect(job.objects.map((o) => o.layer)).toEqual(["cut", "cut", "score"]);
    expect(job.objects[1]!.segments.some((s) => s.type === "arc")).toBe(true);
    expect(job.objects[0]!.matrix).toEqual([1, 0, 0, 1, 10, 10]);
  });

  it("arc direction maps to clockwise", () => {
    const d = new Doc();
    const o = d.add(circle(5), translation(0, 0), "cut");
    const seg = o.path.segs.find((s) => s.t === "a")!;
    const out = toJobObject(o)!.segments.find((s) => s.type === "arc")!;
    expect((out as { clockwise: boolean }).clockwise).toBe(seg.t === "a" ? !seg.ccw : undefined);
  });

  it("turns tab fractions into a distance along the placed outline (after scaling)", () => {
    const d = new Doc();
    const o = d.add(rectangle(40, 20), [2, 0, 0, 2, 5, 5], "cut"); // doubled in size
    o.tabs = { widthMm: 3, at: [0.25, 0.75] };
    const out = toJobObject(o)!;
    const total = pathLength(transformPath(o.path, o.matrix));
    expect(total).toBeCloseTo(240);
    expect(out.tabs).toEqual([{ atLengthMm: 60, widthMm: 3 }, { atLengthMm: 180, widthMm: 3 }]);
    check(buildJob({ objects: [o], pupilId: "P001", presetId: "ply-3mm", origin: { mode: "current-position", anchor: "center" }, submit: false }));
  });

  it("does not send tabs on score lines, and keeps per-shape settings", () => {
    const d = new Doc();
    const o = d.add(rectangle(10, 10), translation(0, 0), "score");
    o.tabs = { widthMm: 2, at: [0.5] };
    o.settings = { powerPct: 30, speedMmPerS: 12 };
    const out = toJobObject(o)!;
    expect(out.tabs).toBeUndefined();
    expect(out.settings).toEqual({ powerPct: 30, speedMmPerS: 12 });
    check(buildJob({ objects: [o], pupilId: "P001", presetId: "ply-3mm", origin: { mode: "absolute" }, submit: false }));
  });

  it("refuses an empty design", () => {
    expect(() => buildJob({ objects: [], pupilId: "P001", presetId: "x", origin: { mode: "absolute" }, submit: true })).toThrow(/nothing/);
  });
});
