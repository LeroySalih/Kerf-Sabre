import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { rectangle, translation } from "../src/geometry";
import { buildJob } from "../src/job";
import { canon, mergeRemoteTabs, sameContent, tabFromJob } from "../src/remotetabs";
import type { JobSummary } from "../src/server";
import { DEFAULT_ORIGIN, blankMeta, fileKey, type Mirror, type MirrorTab } from "../src/workspace";

const docOf = (n: number, materialId = "ply-3mm"): Doc => {
  const d = new Doc();
  d.state.materialId = materialId;
  for (let i = 0; i < n; i++) d.add(rectangle(10, 10), translation(i * 20, 0));
  return d;
};
const jobOf = (id: string, d: Doc, extra: Partial<JobSummary> = {}): JobSummary & { origin: typeof DEFAULT_ORIGIN } => {
  const j = buildJob({ objects: d.state.objects, dimensions: d.state.dimensions, presetId: d.state.materialId, pupilId: "P001", origin: DEFAULT_ORIGIN, submit: false });
  return { ...(j as unknown as JobSummary), id, status: "draft", createdAt: "2026-10-16T14:02:00Z", origin: DEFAULT_ORIGIN, ...extra };
};
const localTab = (name: string, d: Doc, jobId: string | null, clean = true): MirrorTab => ({ name, state: d.state, meta: { ...blankMeta(), jobId, savedKey: clean ? fileKey(d.state) : "" } });
const mirror = (tabs: MirrorTab[], active = 0): Mirror => ({ v: 1, savedAt: "", active, tabs });
const remote = (ids: string[], active: string | null = null) => ({ tabs: ids.map((jobId) => ({ jobId })), active, updatedAt: "x" });

describe("canon", () => {
  it("ignores key order", () => expect(canon({ a: 1, b: [{ y: 1, x: 2 }] })).toBe(canon({ b: [{ x: 2, y: 1 }], a: 1 })));
});

describe("tabs that follow the person", () => {
  it("opens the server's files in a browser that has nothing", async () => {
    const files = { "job-a": jobOf("job-a", docOf(2), { name: "Lid" }), "job-b": jobOf("job-b", docOf(1)) };
    const m = await mergeRemoteTabs({ local: null, remote: remote(["job-b", "job-a"], "job-a"), loadJob: async (id) => files[id as keyof typeof files] ?? null });
    expect(m!.tabs.map((t) => t.meta.jobId)).toEqual(["job-b", "job-a"]); // the server's order
    expect(m!.tabs.map((t) => t.name)).toEqual(["Design 16 Oct 14:02", "Lid"]);
    expect(m!.tabs[1]!.state.objects).toHaveLength(2);
    expect(m!.tabs.every((t) => t.meta.savedKey === fileKey(t.state))).toBe(true); // clean: nothing to save
    expect(m!.active).toBe(1);
  });

  it("keeps this browser's richer copy when it matches the server's file", async () => {
    const d = docOf(2);
    d.group([1, 2]); // groups are not in the job format
    const m = await mergeRemoteTabs({ local: mirror([localTab("Box", d, "job-a")]), remote: remote(["job-a"]), loadJob: async () => jobOf("job-a", d) });
    expect(m!.tabs[0]!.state.objects.map((o) => o.group)).toEqual([1, 1]);
    expect(m!.tabs[0]!.name).toBe("Box");
  });

  it("takes the server's file when it was changed on another browser", async () => {
    const mine = docOf(1);
    const m = await mergeRemoteTabs({ local: mirror([localTab("Box", mine, "job-a")]), remote: remote(["job-a"]), loadJob: async () => jobOf("job-a", docOf(3)) });
    expect(m!.tabs[0]!.state.objects).toHaveLength(3);
  });

  it("keeps this browser's unsaved edits over the server's file", async () => {
    const m = await mergeRemoteTabs({ local: mirror([localTab("Box", docOf(4), "job-a", false)]), remote: remote(["job-a"]), loadJob: async () => jobOf("job-a", docOf(1)) });
    expect(m!.tabs[0]!.state.objects).toHaveLength(4);
  });

  it("never loses work only this browser has, and drops tabs closed elsewhere", async () => {
    const local = mirror([localTab("Closed elsewhere", docOf(1), "job-x"), localTab("Unsaved", docOf(2), null), localTab("Edited, closed elsewhere", docOf(3), "job-y", false)]);
    const m = await mergeRemoteTabs({ local, remote: remote(["job-a"]), loadJob: async () => jobOf("job-a", docOf(1)) });
    expect(m!.tabs.map((t) => t.name)).toEqual(["Design 16 Oct 14:02", "Unsaved", "Edited, closed elsewhere"]);
  });

  it("skips files that are gone or no longer drafts, and falls back to the local copy if the server cannot answer", async () => {
    const m = await mergeRemoteTabs({
      local: mirror([localTab("Kept", docOf(2), "job-c")]),
      remote: remote(["job-gone", "job-sent", "job-c"]),
      loadJob: async (id) => (id === "job-sent" ? jobOf("job-sent", docOf(1), { status: "submitted" }) : null),
    });
    expect(m!.tabs.map((t) => t.name)).toEqual(["Kept"]);
    expect(await mergeRemoteTabs({ local: null, remote: remote(["job-gone"]), loadJob: async () => null })).toBeNull();
  });

  it("recognises same and different content", () => {
    const d = docOf(2);
    expect(sameContent(d.state, jobOf("j", d))).toBe(true);
    expect(sameContent(d.state, jobOf("j", docOf(3)))).toBe(false);
    expect(sameContent(d.state, jobOf("j", docOf(2, "other-material")))).toBe(false);
    expect(sameContent(new Doc().state, jobOf("j", d))).toBe(false);
    expect(tabFromJob(jobOf("j", d), "N", true)).toMatchObject({ name: "N", renamed: true, meta: { jobId: "j" } });
  });
});
