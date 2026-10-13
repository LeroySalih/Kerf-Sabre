import { describe, expect, it } from "vitest";
import { boundsOf, circle, flatten, rectangle, type Path } from "../src/geometry";
import { closePath, deleteNode, endOf, explodePath, insertNode, joinPaths, moveNode, nodePoints, reversePath } from "../src/repair";

const P = (x: number, y: number) => ({ x, y });
const seg = (a: [number, number], b: [number, number]): Path => ({ start: P(...a), segs: [{ t: "l", to: P(...b) }], closed: false });
const near = (a: { x: number; y: number }, x: number, y: number, d = 9) => { expect(a.x).toBeCloseTo(x, d); expect(a.y).toBeCloseTo(y, d); };

describe("reversePath", () => {
  it("swaps the ends and walks back through the same points", () => {
    const p: Path = { start: P(0, 0), segs: [{ t: "l", to: P(5, 0) }, { t: "l", to: P(5, 5) }], closed: false };
    const r = reversePath(p);
    near(r.start, 5, 5);
    near(endOf(r), 0, 0);
    near(r.segs[0]!.to, 5, 0);
  });
  it("flips arcs and swaps curve handles, and reversing twice restores the path", () => {
    const p: Path = {
      start: P(10, 0),
      segs: [{ t: "a", c: P(0, 0), to: P(0, 10), ccw: true }, { t: "c", c1: P(0, 14), c2: P(-4, 14), to: P(-8, 10) }],
      closed: false,
    };
    const r = reversePath(p);
    const a = r.segs[1]!;
    expect(a.t === "a" && a.ccw).toBe(false);
    const c = r.segs[0]!;
    expect(c.t === "c" && c.c1).toEqual(P(-4, 14));
    expect(reversePath(r)).toEqual(p);
  });
});

describe("joinPaths", () => {
  const sides = (): Path[] => [seg([0, 0], [10, 0]), seg([10, 10], [10, 0]), seg([10, 10], [0, 10]), seg([0, 0], [0, 10])]; // shuffled and reversed

  it("joins four loose edges of a square into one closed shape", () => {
    const r = joinPaths(sides(), 0.01);
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]!.closed).toBe(true);
    expect(r.paths[0]!.segs.length).toBe(4);
    expect(r.merges).toBe(3);
    expect(r.newlyClosed).toBe(1);
    expect(boundsOf(r.paths[0]!)).toMatchObject({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  });

  it("the outline is continuous and encloses the original area", () => {
    const p = joinPaths(sides(), 0.01).paths[0]!;
    const pts = flatten(p);
    expect(pts.length).toBe(5); // 4 corners + the start repeated by the closing segment
    near(endOf(p), p.start.x, p.start.y);
  });

  it("does not depend on input order", () => {
    for (let k = 0; k < 4; k++) {
      const s = sides();
      const rotated = [...s.slice(k), ...s.slice(0, k)];
      expect(joinPaths(rotated, 0.01).paths.length).toBe(1);
    }
  });

  it("respects the tolerance", () => {
    const gap = (g: number) => joinPaths([seg([0, 0], [10, 0]), seg([10 + g, 0], [20, 0])], 0.05);
    expect(gap(0.04).paths.length).toBe(1);
    expect(gap(0.2).paths.length).toBe(2);
  });

  it("leaves unrelated chains separate, and open chains open", () => {
    const r = joinPaths([seg([0, 0], [5, 0]), seg([5, 0], [9, 3]), seg([100, 100], [110, 100])], 0.01);
    expect(r.paths.length).toBe(2);
    expect(r.paths.filter((p) => p.closed).length).toBe(0);
    expect(r.newlyClosed).toBe(0);
  });

  it("joins arcs into a circle", () => {
    const top: Path = { start: P(10, 0), segs: [{ t: "a", c: P(0, 0), to: P(-10, 0), ccw: true }], closed: false };
    const bottom: Path = { start: P(-10, 0), segs: [{ t: "a", c: P(0, 0), to: P(10, 0), ccw: true }], closed: false };
    const r = joinPaths([top, bottom], 0.01);
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]!.closed).toBe(true);
    expect(r.paths[0]!.segs.every((s) => s.t === "a")).toBe(true);
  });

  it("passes closed paths through untouched", () => {
    const sq = rectangle(5, 5);
    const r = joinPaths([sq, seg([20, 20], [30, 20])], 0.01);
    expect(r.paths).toContainEqual(sq);
    expect(r.paths.length).toBe(2);
  });

  it("where several ends meet it takes the nearest", () => {
    const r = joinPaths([seg([0, 0], [10, 0]), seg([10.04, 0], [20, 0]), seg([10.01, 5], [20, 5])], 0.05);
    const joined = r.paths.find((p) => p.segs.length === 2)!;
    near(joined.segs[1]!.to, 20, 0, 6); // took the closer one at y=0, not the one at y=5
  });

  it("is fast: 5,000 loose segments make one path", () => {
    const pieces: Path[] = [];
    for (let i = 0; i < 5000; i++) pieces.push(seg([i, Math.sin(i / 7) * 3], [i + 1, Math.sin((i + 1) / 7) * 3]));
    const t0 = Date.now();
    const r = joinPaths(pieces.reverse(), 0.001);
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]!.segs.length).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("closePath", () => {
  const open: Path = { start: P(0, 0), segs: [{ t: "l", to: P(10, 0) }, { t: "l", to: P(10, 10) }, { t: "l", to: P(0.02, 0.01) }], closed: false };
  it("snaps shut when the ends nearly meet", () => {
    const c = closePath(open, 0.05);
    expect(c.closed).toBe(true);
    near(endOf(c), 0, 0);
    expect(c.segs.length).toBe(3);
  });
  it("adds a straight closing edge when the gap is larger", () => {
    const c = closePath({ ...open, segs: open.segs.slice(0, 2) }, 0.05);
    expect(c.closed).toBe(true);
    expect(c.segs.length).toBe(2); // the closing edge is implicit
  });
  it("leaves closed paths alone", () => {
    const sq = rectangle(5, 5);
    expect(closePath(sq, 0.1)).toBe(sq);
  });
});

describe("explodePath", () => {
  it("splits a closed rectangle into its four edges", () => {
    const e = explodePath(rectangle(10, 5));
    expect(e.length).toBe(4);
    expect(e.every((p) => !p.closed && p.segs.length === 1)).toBe(true);
    near(e[3]!.segs[0]!.to, 0, 0); // the implicit closing edge became real
  });
  it("keeps arcs as arcs", () => {
    const e = explodePath(circle(5));
    expect(e.length).toBe(2);
    expect(e.every((p) => p.segs[0]!.t === "a")).toBe(true);
  });
  it("exploding then joining restores a closed shape", () => {
    const r = joinPaths(explodePath(rectangle(10, 5)), 0.001);
    expect(r.paths.length).toBe(1);
    expect(r.paths[0]!.closed).toBe(true);
  });
});

describe("node editing", () => {
  it("lists a closed rectangle's four nodes and an open path's ends", () => {
    expect(nodePoints(rectangle(10, 5)).length).toBe(4);
    expect(nodePoints(seg([0, 0], [4, 4])).length).toBe(2);
  });

  it("moving a corner drags both edges with it", () => {
    const m = moveNode(rectangle(10, 10), 2, P(14, 12)); // corner (10,10)
    expect(nodePoints(m)[2]).toEqual(P(14, 12));
    expect(nodePoints(m)[1]).toEqual(P(10, 0));
    expect(nodePoints(m)[3]).toEqual(P(0, 10));
    expect(m.closed).toBe(true);
  });

  it("moving the start node of a closed path works", () => {
    const m = moveNode(rectangle(10, 10), 0, P(-3, -2));
    expect(nodePoints(m)[0]).toEqual(P(-3, -2));
    near(endOf(m), -3, -2);
  });

  it("moving a node next to an arc turns that arc into a curve, and the shape stays connected", () => {
    const m = moveNode(circle(10), 1, P(-12, 1));
    expect(m.segs.every((s) => s.t === "c")).toBe(true);
    near(nodePoints(m)[1]!, -12, 1);
    near(endOf(m), m.start.x, m.start.y);
  });

  it("curve handles move with their node", () => {
    const p: Path = { start: P(0, 0), segs: [{ t: "c", c1: P(2, 4), c2: P(8, 4), to: P(10, 0) }], closed: false };
    const m = moveNode(p, 0, P(1, 1));
    const s = m.segs[0]!;
    expect(s.t === "c" && s.c1).toEqual(P(3, 5));
  });

  it("inserting a node splits a line without changing its shape", () => {
    const p = insertNode(seg([0, 0], [10, 0]), 0, P(4, 3));
    expect(p.segs.length).toBe(2);
    near(p.segs[0]!.to, 4, 0);
    near(p.segs[1]!.to, 10, 0);
  });

  it("splits an arc into two arcs on the same circle", () => {
    const p = insertNode(circle(10), 0, P(0, 12));
    expect(p.segs.length).toBe(3);
    const a = p.segs[0]!;
    expect(a.t === "a" && Math.hypot(a.to.x, a.to.y)).toBeCloseTo(10, 9);
    near(a.to, 0, 10, 9);
  });

  it("splits a curve and keeps both ends", () => {
    const p: Path = { start: P(0, 0), segs: [{ t: "c", c1: P(0, 10), c2: P(10, 10), to: P(10, 0) }], closed: false };
    const q = insertNode(p, 0, P(5, 7.5));
    expect(q.segs.length).toBe(2);
    near(q.segs[0]!.to, 5, 7.5, 1);
    near(q.segs[1]!.to, 10, 0);
  });

  it("deleting a corner joins its neighbours with a line", () => {
    const d = deleteNode(rectangle(10, 10), 2)!;
    expect(nodePoints(d).length).toBe(3);
    expect(d.closed).toBe(true);
  });

  it("deleting the start node, and the ends of an open path", () => {
    const d0 = deleteNode(rectangle(10, 10), 0)!;
    expect(nodePoints(d0).length).toBe(3);
    near(d0.start, 10, 0);
    const open: Path = { start: P(0, 0), segs: [{ t: "l", to: P(5, 0) }, { t: "l", to: P(5, 5) }], closed: false };
    expect(deleteNode(open, 0)!.start).toEqual(P(5, 0));
    near(endOf(deleteNode(open, 2)!), 5, 0);
    expect(nodePoints(deleteNode(open, 1)!).length).toBe(2);
  });

  it("refuses to delete when too little would remain", () => {
    expect(deleteNode(seg([0, 0], [1, 1]), 0)).toBeNull();
    const tri: Path = { start: P(0, 0), segs: [{ t: "l", to: P(5, 0) }, { t: "l", to: P(0, 5) }], closed: true };
    expect(deleteNode(tri, 1)).toBeNull();
  });
});
