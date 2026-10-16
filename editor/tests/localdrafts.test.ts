import { describe, expect, it } from "vitest";
import { addLocal, listLocal, removeLocal } from "../src/localdrafts";
import type { JobDoc } from "../src/job";

const job = (pupil = "P001", n = 1): JobDoc => ({ schemaVersion: "0.2.19", id: "draft", pupilId: pupil, createdAt: "2026-10-15T09:00:00Z", status: "draft", preset: { id: "ply-3mm", version: 1 }, station: null, origin: { mode: "absolute" },
  objects: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, layer: "cut" as const, closed: true, start: [0, 0] as [number, number], segments: [{ type: "line" as const, to: [10, 0] as [number, number] }], matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number] })) });

class Mem {
  data = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { if (v.length > this.limit) throw new Error("QuotaExceededError"); this.data.set(k, v); }
}

describe("local drafts", () => {
  it("keeps a design and gives it back, newest first, for that pupil only", () => {
    const s = new Mem();
    const a = addLocal(job("P001"), "The job does not match the shared schema.", s, new Date("2026-10-15T09:00:00Z"))!;
    const b = addLocal(job("P002"), "offline", s, new Date("2026-10-15T09:05:00Z"))!;
    const c = addLocal(job("P001"), "again", s, new Date("2026-10-15T09:10:00Z"))!;
    expect(listLocal("P001", s).map((d) => d.id)).toEqual([c.id, a.id]);
    expect(listLocal("P002", s).map((d) => d.id)).toEqual([b.id]);
    expect(listLocal(undefined, s)).toHaveLength(3);
    expect(listLocal("P001", s)[1]!.reason).toContain("shared schema");
  });
  it("removes a draft once it has reached the server", () => {
    const s = new Mem();
    const a = addLocal(job(), "x", s)!;
    addLocal(job(), "y", s);
    removeLocal(a.id, s);
    expect(listLocal("P001", s).map((d) => d.reason)).toEqual(["y"]);
  });
  it("keeps only the newest ten", () => {
    const s = new Mem();
    for (let i = 0; i < 14; i++) addLocal(job(), `n${i}`, s);
    const all = listLocal("P001", s);
    expect(all).toHaveLength(10);
    expect(all[0]!.reason).toBe("n13");
  });
  it("lets the oldest go when the browser's storage is nearly full, and says so only if even one will not fit", () => {
    const s = new Mem();
    const one = JSON.stringify([addLocal(job("P001", 1), "a", new Mem())]).length;
    s.limit = one * 2 + 50;
    addLocal(job("P001", 1), "first", s);
    addLocal(job("P001", 1), "second", s);
    const third = addLocal(job("P001", 1), "third", s);
    expect(third).not.toBeNull();
    expect(listLocal("P001", s).map((d) => d.reason)).toEqual(["third", "second"]);
    s.limit = 10;
    expect(addLocal(job("P001", 1), "too big", s)).toBeNull();
  });
  it("survives blocked or corrupt storage", () => {
    expect(addLocal(job(), "x", null)).toBeNull();
    expect(listLocal("P001", null)).toEqual([]);
    const s = new Mem();
    s.setItem("kerf.localdrafts", "{not json");
    expect(listLocal("P001", s)).toEqual([]);
    expect(addLocal(job(), "ok", s)).not.toBeNull();
    s.setItem("kerf.localdrafts", JSON.stringify([{ id: 5 }, { id: "x", job: { objects: [] } }, null]));
    expect(listLocal(undefined, s).map((d) => d.id)).toEqual(["x"]);
  });
});
