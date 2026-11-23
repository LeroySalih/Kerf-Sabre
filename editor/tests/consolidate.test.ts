import { describe, expect, it } from "vitest";
import { addFilesToDoc, describeFile, filesForClass, materialWarning, planLayout } from "../src/consolidate";
import { Doc } from "../src/doc";
import { boundsOf, rectangle, transformPath, translation } from "../src/geometry";
import { DEFAULT_ORIGIN } from "../src/workspace";
import { buildJob } from "../src/job";
import type { ClassPupil, JobSummary } from "../src/server";

const pupils: ClassPupil[] = [{ pupilId: "P1", lastLogin: null, locked: false }, { pupilId: "P2", displayName: "Ada Lovelace", lastLogin: null, locked: false }];

function file(id: string, pupilId: string, w: number, h: number, extra: Partial<JobSummary> = {}, material = "ply-3mm"): JobSummary {
  const d = new Doc();
  const a = d.add(rectangle(w, h), translation(40, 60), "cut"); // not at the origin: the layout must not care where it was drawn
  a.settings = { powerPct: 50, speedMmPerS: 4 };
  d.add(rectangle(w / 4, h / 4), translation(45, 65), "score");
  const j = buildJob({ objects: d.state.objects, presetId: material, pupilId, origin: DEFAULT_ORIGIN, submit: false });
  return { ...(j as unknown as JobSummary), id, pupilId, status: "approved", createdAt: "2026-11-20T10:00:00Z", ...extra };
}

describe("which files are in the queue for the class", () => {
  it("keeps this class's pupils' waiting files only, sorted by pupil then date", () => {
    const jobs = [
      file("j1", "P2", 10, 10, { createdAt: "2026-11-20T12:00:00Z" }),
      file("j2", "P1", 10, 10),
      file("j3", "P9", 10, 10), // another class
      file("j4", "P1", 10, 10, { status: "done" }), // already cut
      file("j5", "P1", 10, 10, { status: "draft" }),
      file("j6", "P2", 10, 10, { status: "submitted", createdAt: "2026-11-20T09:00:00Z" }),
    ];
    expect(filesForClass(jobs, pupils).map((j) => j.id)).toEqual(["j2", "j6", "j1"]);
  });
  it("describes a file for the list", () => {
    const j = file("j1", "P2", 10, 10, { ticket: 7, pupilName: "Ada Lovelace", estimate: { extentMm: { widthMm: 120.4, heightMm: 80 } } });
    expect(describeFile(j, () => "Plywood 3 mm")).toBe("Ada Lovelace · ticket 7 · 120 × 80 mm · Plywood 3 mm");
    expect(describeFile(file("j2", "P1", 1, 1, { status: "submitted" }))).toBe("P1 · waiting for approval · ply-3mm");
  });
  it("warns about mixed materials, not about one", () => {
    const a = file("a", "P1", 10, 10), b = file("b", "P2", 10, 10, {}, "acrylic-3mm");
    expect(materialWarning([a, a])).toBe("");
    expect(materialWarning([a])).toBe("");
    expect(materialWarning([a, b])).toMatch(/different materials \(ply-3mm, acrylic-3mm\)/);
  });
});

describe("laying the files out", () => {
  const bed = { widthMm: 400, heightMm: 400 };
  it("packs left to right in rows and wraps", () => {
    const { at, fits } = planLayout([{ w: 150, h: 100 }, { w: 150, h: 60 }, { w: 150, h: 80 }, { w: 100, h: 50 }], bed);
    expect(at).toEqual([{ x: 10, y: 10 }, { x: 168, y: 10 }, { x: 10, y: 118 }, { x: 168, y: 118 }]); // third wraps under the tallest of row one
    expect(fits).toBe(true);
  });
  it("carries on past the bed and says it does not fit, rather than refusing", () => {
    const r = planLayout([{ w: 300, h: 300 }, { w: 300, h: 300 }], bed);
    expect(r.fits).toBe(false);
    expect(r.at).toHaveLength(2);
    expect(planLayout([{ w: 500, h: 20 }], bed).fits).toBe(false);
  });
});

describe("importing into the document", () => {
  const bed = { widthMm: 400, heightMm: 415 };
  const jobs = [file("a", "P1", 100, 60), file("b", "P2", 120, 80, { pupilName: "Ada Lovelace" }), file("c", "P1", 90, 90)];

  it("makes each file one group, with its settings, side by side and not overlapping", () => {
    const d = new Doc();
    const r = addFilesToDoc(d, jobs, { labels: false, bed });
    expect(r.groups).toBe(3);
    expect(r.ids).toHaveLength(6);
    const groups = new Map<number, DocBox>();
    for (const o of d.state.objects) {
      const b = boundsOf(transformPath(o.path, o.matrix));
      const g = groups.get(o.group!) ?? { ...b };
      groups.set(o.group!, { minX: Math.min(g.minX, b.minX), minY: Math.min(g.minY, b.minY), maxX: Math.max(g.maxX, b.maxX), maxY: Math.max(g.maxY, b.maxY) });
    }
    expect(groups.size).toBe(3);
    const boxes = [...groups.values()];
    expect(boxes[0]).toMatchObject({ minX: 10, minY: 10 }); // starts at the margin, wherever it was drawn
    for (let i = 0; i < boxes.length; i++) for (let k = i + 1; k < boxes.length; k++) {
      const a = boxes[i]!, b = boxes[k]!;
      expect(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY, `groups ${i} and ${k} overlap`).toBe(true);
    }
    expect(d.state.objects.filter((o) => o.settings).length).toBe(3); // each file's per-shape settings came too
    expect(d.state.objects.filter((o) => o.layer === "cut")).toHaveLength(3);
    expect(d.state.objects.filter((o) => o.layer === "score")).toHaveLength(3);
  });

  it("adds a name label above each file on the Ignore layer, inside the same group", () => {
    const d = new Doc();
    addFilesToDoc(d, [jobs[1]!], { labels: true, bed });
    const labels = d.state.objects.filter((o) => o.layer === "ignore");
    expect(labels.length).toBeGreaterThan(3); // "Ada Lovelace" drawn as strokes
    expect(new Set(d.state.objects.map((o) => o.group)).size).toBe(1);
    const body = d.state.objects.filter((o) => o.layer !== "ignore").map((o) => boundsOf(transformPath(o.path, o.matrix)));
    const top = Math.max(...body.map((b) => b.maxY));
    for (const l of labels) expect(boundsOf(transformPath(l.path, l.matrix)).minY).toBeGreaterThanOrEqual(top); // above the file, not on it
  });

  it("skips a file with nothing in it and says so", () => {
    const empty = { ...file("e", "P1", 10, 10), objects: [] };
    const d = new Doc();
    const r = addFilesToDoc(d, [empty, jobs[0]!], { labels: false, bed });
    expect(r.groups).toBe(1);
    expect(r.skipped).toEqual(["P1"]);
  });

  it("adds to what is already in the document without touching it", () => {
    const d = new Doc();
    d.add(rectangle(5, 5), translation(1, 1), "cut");
    addFilesToDoc(d, [jobs[0]!], { labels: false, bed });
    expect(d.state.objects).toHaveLength(3);
    expect(d.state.objects[0]!.group).toBeUndefined();
  });
});

interface DocBox { minX: number; minY: number; maxX: number; maxY: number }
