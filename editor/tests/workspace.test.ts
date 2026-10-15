import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { rectangle, translation } from "../src/geometry";
import { Workspace, blankMeta, fileKey, isDirty, matches, pasteIntoSnapshot, snapshotOf, uniqueName } from "../src/workspace";

const docWith = (n: number): Doc => {
  const d = new Doc();
  for (let i = 0; i < n; i++) d.add(rectangle(10, 10), translation(i * 20, 0));
  return d;
};

describe("Doc snapshot and restore", () => {
  it("parks a document with its own undo history", () => {
    const a = docWith(1);
    a.checkpoint(); a.add(rectangle(5, 5), translation(0, 0));
    const parked = a.snapshot();
    a.restore({ state: new Doc().state, undo: [], redo: [] });
    expect(a.state.objects).toHaveLength(0);
    expect(a.undo()).toBe(false); // the other file's history is not this one's
    a.restore(parked);
    expect(a.state.objects).toHaveLength(2);
    expect(a.undo()).toBe(true);
    expect(a.state.objects).toHaveLength(1);
  });
});

describe("Workspace", () => {
  it("starts with one empty tab", () => {
    const w = new Workspace();
    expect(w.tabs).toHaveLength(1);
    expect(w.active().name).toBe("Untitled");
  });

  it("never opens the same file twice: finds it by draft id, by the file it copies, or by its local copy", () => {
    const w = new Workspace();
    const t = w.add("job-1", docWith(1).snapshot(), { ...blankMeta(), jobId: "job-1" });
    const c = w.add("copy of job-2", docWith(1).snapshot(), { ...blankMeta(), sourceId: "job-2" });
    const l = w.add("local", docWith(1).snapshot(), { ...blankMeta(), openedLocal: "loc-9" });
    expect(w.find({ jobId: "job-1" })).toBe(t);
    expect(w.find({ sourceId: "job-2" })).toBe(c);
    expect(w.find({ localId: "loc-9" })).toBe(l);
    expect(w.find({ jobId: "job-3" })).toBeUndefined();
    // once a copy has been saved it has its own id and no longer stands in for the original
    expect(matches({ ...blankMeta(), jobId: "job-5", sourceId: "job-2" }, { sourceId: "job-2" })).toBe(false);
  });

  it("duplicates a tab as a new, unsaved file", () => {
    const w = new Workspace();
    const src = w.add("Box", docWith(2).snapshot(), { ...blankMeta(), jobId: "job-1", savedKey: "k" });
    const dup = w.duplicate(src);
    expect(dup.name).toBe("Box copy");
    expect(dup.meta.jobId).toBeNull();
    expect(dup.snap.state.objects).toHaveLength(2);
    dup.snap.state.objects.pop(); // editing the copy leaves the original alone
    expect(src.snap.state.objects).toHaveLength(2);
    expect(w.names()).toEqual(["Untitled", "Box", "Box copy"]);
    expect(w.duplicate(src).name).toBe("Box copy 2");
  });

  it("closing the active tab shows its neighbour; closing the last leaves a blank tab", () => {
    const w = new Workspace();
    const a = w.active();
    const b = w.add("B", docWith(1).snapshot(), blankMeta());
    w.activeId = b.id;
    expect(w.close(b.id)).toBe(a);
    expect(w.activeId).toBe(a.id);
    const fresh = w.close(a.id)!;
    expect(w.tabs).toEqual([fresh]);
    expect(fresh.snap.state.objects).toHaveLength(0);
  });

  it("closing a background tab changes nothing on screen", () => {
    const w = new Workspace();
    const b = w.add("B", docWith(1).snapshot(), blankMeta());
    expect(w.close(b.id)).toBeNull();
    expect(w.tabs).toHaveLength(1);
  });

  it("reset leaves one empty tab", () => {
    const w = new Workspace();
    w.add("B", docWith(1).snapshot(), blankMeta());
    w.reset();
    expect(w.tabs).toHaveLength(1);
    expect(w.active().snap.state.objects).toHaveLength(0);
  });
});

describe("moving shapes between tabs", () => {
  it("makes a new file from some shapes, keeping their place, layer and groups", () => {
    const d = docWith(3);
    d.setLayer([2], "score");
    d.group([1, 2]);
    const snap = snapshotOf(d.copyOut([1, 2]), "ply-3mm");
    expect(snap.state.objects.map((o) => o.layer)).toEqual(["cut", "score"]);
    expect(snap.state.objects.map((o) => o.matrix[4])).toEqual([0, 20]);
    expect(new Set(snap.state.objects.map((o) => o.group)).size).toBe(1);
    expect(snap.state.materialId).toBe("ply-3mm");
  });

  it("adds shapes to another tab as one undoable step there", () => {
    const target = docWith(1);
    const parked = target.snapshot();
    const n = pasteIntoSnapshot(parked, docWith(2).copyOut([1, 2]));
    expect(n).toBe(2);
    const back = new Doc();
    back.restore(parked);
    expect(back.state.objects).toHaveLength(3);
    back.undo();
    expect(back.state.objects).toHaveLength(1);
  });
});

describe("unsaved changes", () => {
  it("an empty tab is never dirty; a saved one is clean until it changes", () => {
    const d = docWith(1);
    expect(isDirty(new Doc().state, "")).toBe(false);
    expect(isDirty(d.state, "")).toBe(true);
    const saved = fileKey(d.state);
    expect(isDirty(d.state, saved)).toBe(false);
    d.add(rectangle(1, 1), translation(0, 0));
    expect(isDirty(d.state, saved)).toBe(true);
  });
  it("makes names unique", () => {
    expect(uniqueName(["A"], "B")).toBe("B");
    expect(uniqueName(["A", "A 2"], "A")).toBe("A 3");
  });
});
