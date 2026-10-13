import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { rectangle, translation } from "../src/geometry";

function setup() {
  const d = new Doc();
  const a = d.add(rectangle(5, 5), translation(0, 0)).id;
  const b = d.add(rectangle(5, 5), translation(20, 0)).id;
  const c = d.add(rectangle(5, 5), translation(40, 0)).id;
  return { d, a, b, c };
}

describe("groups", () => {
  it("grouping makes selecting one member select all", () => {
    const { d, a, b, c } = setup();
    d.group([a, b]);
    expect(d.expand([a]).sort()).toEqual([a, b].sort());
    expect(d.expand([c])).toEqual([c]);
  });

  it("needs at least two objects", () => {
    const { d, a } = setup();
    expect(d.group([a])).toBeUndefined();
    expect(d.get(a)!.group).toBeUndefined();
  });

  it("ungroup dissolves the whole group from any member", () => {
    const { d, a, b } = setup();
    d.group([a, b]);
    d.ungroup([b]);
    expect(d.expand([a])).toEqual([a]);
    expect(d.get(b)!.group).toBeUndefined();
  });

  it("grouping a group with another object merges them into one group", () => {
    const { d, a, b, c } = setup();
    d.group([a, b]);
    d.group([a, c]);
    expect(d.expand([c]).sort()).toEqual([a, b, c].sort());
  });

  it("moving every member by the same matrix keeps their relative layout", () => {
    const { d, a, b } = setup();
    d.group([a, b]);
    for (const id of d.expand([a])) d.transform(id, translation(3, 4));
    expect(d.get(b)!.matrix[4] - d.get(a)!.matrix[4]).toBe(20);
  });

  it("group state survives undo/redo", () => {
    const { d, a, b } = setup();
    d.checkpoint();
    d.group([a, b]);
    d.undo();
    expect(d.get(a)!.group).toBeUndefined();
    d.redo();
    expect(d.get(a)!.group).toBeDefined();
  });
});
