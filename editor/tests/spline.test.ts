import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { rectangle, translation } from "../src/geometry";
import { nodePoints } from "../src/repair";
import { cleanPoints, splinePath } from "../src/spline";
import { buildJob } from "../src/job";

const P = (x: number, y: number) => ({ x, y });
const pts = [P(0, 0), P(20, 15), P(45, 5), P(70, 30), P(90, 0)];

describe("splinePath", () => {
  it("is a chain of cubics that passes through every point, in order", () => {
    const path = splinePath(pts, false)!;
    expect(path.closed).toBe(false);
    expect(path.segs).toHaveLength(4);
    expect(path.segs.every((s) => s.t === "c")).toBe(true);
    expect(nodePoints(path)).toEqual(pts);
  });

  it("is smooth at the points: the handles either side of a point line up", () => {
    const path = splinePath(pts, false)!;
    for (let i = 0; i < path.segs.length - 1; i++) {
      const a = path.segs[i]!, b = path.segs[i + 1]!;
      if (a.t !== "c" || b.t !== "c") throw new Error("expected cubics");
      const j = a.to;
      const cross = (a.c2.x - j.x) * (b.c1.y - j.y) - (a.c2.y - j.y) * (b.c1.x - j.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6); // collinear through the joint
      expect((a.c2.x - j.x) * (b.c1.x - j.x) + (a.c2.y - j.y) * (b.c1.y - j.y)).toBeLessThan(0); // on opposite sides of it
    }
  });

  it("closes smoothly, returning to its start", () => {
    const path = splinePath([P(0, 0), P(40, 0), P(40, 30), P(0, 30)], true)!;
    expect(path.closed).toBe(true);
    expect(path.segs).toHaveLength(4);
    expect(path.segs[3]!.to).toEqual(P(0, 0));
    const first = path.segs[0]!, last = path.segs[3]!;
    if (first.t !== "c" || last.t !== "c") throw new Error("expected cubics");
    const cross = (last.c2.x - 0) * (first.c1.y - 0) - (last.c2.y - 0) * (first.c1.x - 0);
    expect(Math.abs(cross)).toBeLessThan(1e-6); // no kink where it closes
  });

  it("two points make a straight line; too few points make nothing", () => {
    expect(splinePath([P(0, 0), P(10, 0)], false)!.segs).toEqual([{ t: "l", to: P(10, 0) }]);
    expect(splinePath([P(0, 0)], false)).toBeNull();
    expect(splinePath([P(0, 0), P(5, 5)], true)).toBeNull();
    expect(splinePath([P(1, 1), P(1, 1), P(1, 1)], false)).toBeNull();
  });

  it("ignores repeated points (a double-click) and never produces NaN", () => {
    expect(cleanPoints([P(0, 0), P(0, 0), P(5, 5), P(5, 5)], false)).toEqual([P(0, 0), P(5, 5)]);
    expect(cleanPoints([P(0, 0), P(5, 5), P(9, 1), P(0, 0)], true)).toHaveLength(3);
    const path = splinePath([P(0, 0), P(0, 0), P(10, 0), P(10, 0), P(10, 10)], false)!;
    expect(JSON.stringify(path)).not.toMatch(/null|NaN/);
  });

  it("stays tame with very uneven spacing (no overshoot or loops)", () => {
    const path = splinePath([P(0, 0), P(1, 0), P(2, 0.5), P(100, 0), P(101, 0)], false)!;
    const ys = path.segs.flatMap((s) => (s.t === "c" ? [s.c1.y, s.c2.y] : []));
    expect(Math.max(...ys.map(Math.abs))).toBeLessThan(5);
  });
});

describe("splines in the document", () => {
  it("are plain cubic curves in the job, so the server cuts them like any shape", () => {
    const d = new Doc();
    const o = d.add(splinePath(pts, false)!, translation(0, 0), "cut");
    o.spline = { points: pts, closed: false };
    const job = buildJob({ objects: d.state.objects, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false });
    expect(job.objects[0]!.segments.every((s) => s.type === "cubic")).toBe(true);
    expect("spline" in job.objects[0]!).toBe(false);
  });

  it("stop being live splines once baked into a plain path, and survive undo", () => {
    const d = new Doc();
    const o = d.add(splinePath(pts, false)!, translation(0, 0), "cut");
    o.spline = { points: pts, closed: false };
    const other = d.add(rectangle(5, 5), translation(0, 0), "cut");
    d.checkpoint();
    d.convertText([other.id]);
    expect(d.get(o.id)!.spline).toBeDefined(); // untouched objects keep theirs
    d.convertText([o.id]);
    expect(d.get(o.id)!.spline).toBeUndefined();
    d.undo();
    expect(d.get(o.id)!.spline).toEqual({ points: pts, closed: false });
  });
});
