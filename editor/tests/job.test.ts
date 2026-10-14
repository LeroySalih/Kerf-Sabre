import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { circle, rectangle, translation } from "../src/geometry";
import { buildJob, fromJobObjects, toJobObject } from "../src/job";
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

describe("opening a stored job again", () => {
  it("round-trips shapes, arcs, tabs and per-shape settings", () => {
    const d = new Doc();
    const a = d.add(rectangle(40, 20), [2, 0, 0, 2, 5, 5], "cut");
    a.tabs = { widthMm: 3, at: [0.25, 0.75] };
    const c = d.add(circle(5), translation(30, 30), "score");
    c.settings = { powerPct: 20, speedMmPerS: 9 };
    const back = fromJobObjects(d.state.objects.map((o) => toJobObject(o)!));
    expect(back).toHaveLength(2);
    expect(back[0]!.path).toEqual(a.path);
    expect(back[0]!.matrix).toEqual(a.matrix);
    expect(back[0]!.tabs!.widthMm).toBe(3);
    expect(back[0]!.tabs!.at[0]).toBeCloseTo(0.25);
    expect(back[0]!.tabs!.at[1]).toBeCloseTo(0.75);
    expect(back[1]!.path).toEqual(c.path);
    expect(back[1]!.layer).toBe("score");
    expect(back[1]!.settings).toEqual({ powerPct: 20, speedMmPerS: 9 });
  });
});

describe("Doc.reset", () => {
  it("clears the shapes and the undo history", () => {
    const d = new Doc();
    d.checkpoint();
    d.add(rectangle(1, 1), translation(0, 0), "cut");
    d.reset();
    expect(d.state.objects).toHaveLength(0);
    expect(d.undo()).toBe(false);
  });
});

describe("activities", () => {
  it("a file can say which class activity it is for, and the shared schema accepts it", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), translation(0, 0), "cut");
    const withAct = buildJob({ objects: d.state.objects, activityId: "act-1234", pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false });
    expect(withAct.activityId).toBe("act-1234");
    check(withAct);
    const none = buildJob({ objects: d.state.objects, activityId: null, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false });
    expect(none.activityId).toBeNull();
    check(none);
    expect("activityId" in buildJob({ objects: d.state.objects, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false })).toBe(false);
  });
});
