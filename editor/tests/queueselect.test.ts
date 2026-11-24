import { describe, expect, it } from "vitest";
import { bulkText, prune, runEach, toggleAll } from "../src/queueselect";

describe("queue selection", () => {
  it("forgets files that left the page", () => {
    expect([...prune(new Set(["a", "b", "c"]), ["b", "c", "d"])]).toEqual(["b", "c"]);
  });
  it("ticks all shown, or unticks them when all are ticked, leaving hidden ticks alone", () => {
    expect([...toggleAll(new Set(["x"]), ["a", "b"])].sort()).toEqual(["a", "b", "x"]);
    expect([...toggleAll(new Set(["a", "b", "x"]), ["a", "b"])]).toEqual(["x"]);
    expect([...toggleAll(new Set(), [])]).toEqual([]);
  });
  it("runs one by one and reports the failures", async () => {
    const order: string[] = [];
    const seen: number[] = [];
    const r = await runEach(["a", "b", "c"], async (id) => { order.push(id); if (id === "b") throw new Error("too big for the sheet"); }, (d) => seen.push(d));
    expect(order).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([1, 2, 3]);
    expect(r).toEqual({ done: ["a", "c"], failed: [{ id: "b", message: "too big for the sheet" }] });
    expect(bulkText(r, "cancelled", (id) => `Ticket ${id}`)).toEqual(["2 files cancelled.", "Ticket b: too big for the sheet"]);
    expect(bulkText({ done: ["a"], failed: [] }, "cancelled")).toEqual(["1 file cancelled."]);
  });
});
