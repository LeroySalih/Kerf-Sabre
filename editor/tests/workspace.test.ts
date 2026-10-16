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

import { MAX_CLOSED, addClosed, readClosed, removeClosed, mirrorKey, parseMirror, readMirror, removeMirror, serializeMirror, writeMirror } from "../src/workspace";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
};

describe("keeping the open tabs in the browser", () => {
  function twoTabs(): { w: Workspace; live: Doc } {
    const w = new Workspace();
    const live = docWith(2);
    w.active().name = "Lid";
    w.add("Box", docWith(3).snapshot(), { ...blankMeta(), jobId: "job-7", savedKey: "k7" }).renamed = true;
    return { w, live };
  }

  it("round-trips every tab, using the live page for the one showing", () => {
    const { w, live } = twoTabs();
    const text = serializeMirror(w, { state: live.state, meta: { ...blankMeta(), jobId: "job-1" } });
    const m = parseMirror(text)!;
    expect(m.tabs.map((t) => t.name)).toEqual(["Lid", "Box"]);
    expect(m.tabs[0]!.state.objects).toHaveLength(2); // the live page, not the stale parked snapshot
    expect(m.tabs[0]!.meta.jobId).toBe("job-1");
    expect(m.tabs[1]!.state.objects).toHaveLength(3);
    expect(m.tabs[1]).toMatchObject({ renamed: true, meta: { jobId: "job-7", savedKey: "k7" } });
    expect(m.active).toBe(0);
  });

  it("keeps groups, text specs and settings (it is not the lossy job format)", () => {
    const d = docWith(2);
    d.group([1, 2]);
    d.state.objects[0]!.settings = { powerPct: 50, speedMmPerS: 5 };
    const w = new Workspace();
    const m = parseMirror(serializeMirror(w, { state: d.state, meta: blankMeta() }))!;
    expect(m.tabs[0]!.state.objects.map((o) => o.group)).toEqual([1, 1]);
    expect(m.tabs[0]!.state.objects[0]!.settings).toEqual({ powerPct: 50, speedMmPerS: 5 });
  });

  it("ignores anything damaged or foreign instead of half-loading it", () => {
    expect(parseMirror(null)).toBeNull();
    expect(parseMirror("not json")).toBeNull();
    expect(parseMirror(JSON.stringify({ v: 2, tabs: [] }))).toBeNull();
    expect(parseMirror(JSON.stringify({ v: 1, tabs: [] }))).toBeNull();
    const { w, live } = twoTabs();
    const bad = JSON.parse(serializeMirror(w, { state: live.state, meta: blankMeta() }));
    bad.tabs[1].state.objects[0].matrix = [1, 2, 3];
    expect(parseMirror(JSON.stringify(bad))).toBeNull();
    bad.tabs[1].state.objects[0].matrix = [1, 0, 0, 1, 0, 0];
    bad.tabs[1].state.objects[0].layer = "engrave";
    expect(parseMirror(JSON.stringify(bad))).toBeNull();
  });

  it("is stored per person, so one pupil never gets another's tabs back", () => {
    const store = memory();
    const { w, live } = twoTabs();
    expect(writeMirror("P001", serializeMirror(w, { state: live.state, meta: blankMeta() }), store)).toBe(true);
    expect(readMirror("P001", store)?.tabs).toHaveLength(2);
    expect(readMirror("P002", store)).toBeNull();
    expect(store.m.has(mirrorKey("P001"))).toBe(true);
    removeMirror("P001", store);
    expect(readMirror("P001", store)).toBeNull();
  });

  it("reports a full browser instead of throwing", () => {
    const full = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
    expect(writeMirror("P001", "{}", full)).toBe(false);
    expect(writeMirror("P001", "{}", null)).toBe(false);
  });

  it("puts the saved tabs back: replacing an untouched workspace, or joining work already open", () => {
    const { w, live } = twoTabs();
    const m = parseMirror(serializeMirror(w, { state: live.state, meta: { ...blankMeta(), jobId: "job-1" } }))!;

    const fresh = new Workspace();
    expect(fresh.pristine(true)).toBe(true);
    const shown = fresh.absorb(m, true);
    expect(fresh.names()).toEqual(["Lid", "Box"]);
    expect(shown.name).toBe("Lid");
    expect(fresh.activeId).toBe(shown.id);
    expect(fresh.pristine(false)).toBe(false);

    const busy = new Workspace();
    busy.add("Other", docWith(1).snapshot(), { ...blankMeta(), jobId: "job-7" }); // job-7 is already open here
    const stay = busy.absorb(m, false);
    expect(busy.names()).toEqual(["Untitled", "Other", "Lid"]); // job-7 was not added a second time
    expect(stay).toBe(busy.active());
  });
});


describe("files closed in the browser", () => {
  const tab = (n: number, jobId: string | null = null) => ({ name: `T${n}`, state: docWith(n).state, meta: { ...blankMeta(), jobId } });

  it("keeps a closed file for the person who closed it, newest first, and nobody else", () => {
    const store = memory();
    expect(addClosed("P001", tab(2), store)).toBe(true);
    expect(addClosed("P001", tab(3), store)).toBe(true);
    expect(readClosed("P001", store).map((f) => f.name)).toEqual(["T3", "T2"]);
    expect(readClosed("P002", store)).toEqual([]);
    const id = readClosed("P001", store)[0]!.id;
    removeClosed("P001", id, store);
    expect(readClosed("P001", store).map((f) => f.name)).toEqual(["T2"]);
  });

  it("does not keep an empty file, and keeps one server file once", () => {
    const store = memory();
    expect(addClosed("P001", tab(0), store)).toBe(false);
    addClosed("P001", tab(1, "job-1"), store);
    addClosed("P001", tab(2, "job-1"), store);
    expect(readClosed("P001", store).map((f) => f.name)).toEqual(["T2"]);
  });

  it("keeps only the newest few, and copes with a full browser", () => {
    const store = memory();
    for (let i = 1; i <= MAX_CLOSED + 5; i++) addClosed("P001", tab(1, `job-${i}`), store);
    expect(readClosed("P001", store)).toHaveLength(MAX_CLOSED);
    expect(readClosed("P001", store)[0]!.meta.jobId).toBe(`job-${MAX_CLOSED + 5}`);
    const full = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
    expect(addClosed("P001", tab(1), full)).toBe(false);
  });

  it("ignores damaged entries", () => {
    const store = memory();
    store.setItem("kerf.closed.P001", JSON.stringify([{ id: "x", name: "bad", state: { objects: [{ nope: 1 }] } }, "junk"]));
    expect(readClosed("P001", store)).toEqual([]);
    store.setItem("kerf.closed.P001", "not json");
    expect(readClosed("P001", store)).toEqual([]);
  });
});
