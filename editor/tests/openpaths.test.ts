import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { line, rectangle, translation, polylinePath } from "../src/geometry";
import { describeOpen, openCutCount, openEnds, openPaths } from "../src/openpaths";

function sample(): Doc {
  const d = new Doc();
  d.add(rectangle(20, 20), translation(0, 0), "cut"); // closed: fine
  d.add(line(30, 0), translation(50, 10), "cut"); // open on Cut, from (50,10) to (80,10)
  d.add(line(0, 15), translation(5, 5), "score"); // open on Score
  d.add(line(10, 10), translation(0, 0), "ignore"); // open but never cut
  d.add(polylinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false)!, translation(100, 100), "cut"); // open polyline
  return d;
}

describe("open paths", () => {
  it("finds the open shapes on Cut and Score, never closed ones or the Ignore layer", () => {
    const d = sample();
    expect(openPaths(d.state.objects).map((o) => o.layer)).toEqual(["cut", "score", "cut"]);
    expect(openCutCount(d.state.objects)).toBe(2);
  });

  it("gives both free ends of each, in bed mm after the shape's placement", () => {
    const e = openEnds(sample().state.objects);
    expect(e).toHaveLength(6);
    expect(e.filter((p) => p.layer === "cut").map((p) => [p.x, p.y])).toEqual([[50, 10], [80, 10], [100, 100], [110, 110]]);
    expect(e.filter((p) => p.layer === "score").map((p) => [p.x, p.y])).toEqual([[5, 5], [5, 20]]);
  });

  it("follows a moved shape", () => {
    const d = new Doc();
    const o = d.add(line(10, 0), translation(0, 0), "cut");
    d.transform(o.id, translation(5, 7));
    expect(openEnds(d.state.objects).map((p) => [p.x, p.y])).toEqual([[5, 7], [15, 7]]);
  });

  it("says what it found in plain words", () => {
    expect(describeOpen(new Doc().state.objects)).toBe("No open paths: every shape is closed.");
    expect(describeOpen(sample().state.objects)).toBe("2 open paths on the Cut layer (large red dots): they would cut a line, not a part; 1 open line on the Score layer (small red rings): these are fine.");
  });
});
