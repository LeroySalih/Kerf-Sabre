// Build a job document (shared/job.schema.json) from the Editor's objects. Pure.
// Tabs are stored in the Editor as fractions along the outline; the schema wants a distance in bed space
// (after the matrix) from the object's start point, so they are converted here.
import type { DocObject } from "./doc";
import { transformPath, type Matrix, type Path } from "./geometry";
import { pathLength } from "./tabs";

export type Anchor = "top-left" | "top-center" | "top-right" | "middle-left" | "center" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type Origin = { mode: "absolute" } | { mode: "current-position"; anchor: Anchor };

export const ANCHORS: { value: Anchor; label: string }[] = [
  { value: "bottom-left", label: "bottom-left corner" },
  { value: "bottom-center", label: "bottom edge, middle" },
  { value: "bottom-right", label: "bottom-right corner" },
  { value: "middle-left", label: "left edge, middle" },
  { value: "center", label: "centre" },
  { value: "middle-right", label: "right edge, middle" },
  { value: "top-left", label: "top-left corner" },
  { value: "top-center", label: "top edge, middle" },
  { value: "top-right", label: "top-right corner" },
];

type JobSegment =
  | { type: "line"; to: [number, number] }
  | { type: "arc"; to: [number, number]; center: [number, number]; clockwise: boolean }
  | { type: "cubic"; c1: [number, number]; c2: [number, number]; to: [number, number] };

export interface JobObject {
  id: string;
  layer: "score" | "cut";
  closed: boolean;
  start: [number, number];
  segments: JobSegment[];
  matrix: Matrix;
  tabs?: { atLengthMm: number; widthMm: number }[];
  settings?: { powerPct?: number; speedMmPerS?: number };
}

export interface JobDoc {
  schemaVersion: "0.2.0";
  id: string;
  pupilId: string;
  createdAt: string;
  status: "draft" | "submitted";
  preset: { id: string; version: number };
  station: null;
  origin: Origin;
  objects: JobObject[];
}

const pt = (p: { x: number; y: number }): [number, number] => [p.x, p.y];

export function toJobObject(o: DocObject): JobObject | null {
  const p: Path = o.path;
  if (!p.segs.length) return null;
  const out: JobObject = {
    id: String(o.id),
    layer: o.layer,
    closed: p.closed,
    start: pt(p.start),
    segments: p.segs.map((s): JobSegment =>
      s.t === "l" ? { type: "line", to: pt(s.to) }
      : s.t === "a" ? { type: "arc", to: pt(s.to), center: pt(s.c), clockwise: !s.ccw }
      : { type: "cubic", c1: pt(s.c1), c2: pt(s.c2), to: pt(s.to) }),
    matrix: [...o.matrix] as Matrix,
  };
  if (o.tabs && o.tabs.at.length && p.closed && o.layer === "cut") {
    const total = pathLength(transformPath(p, o.matrix));
    out.tabs = o.tabs.at.map((f) => ({ atLengthMm: ((f % 1) + 1) % 1 * total, widthMm: o.tabs!.widthMm }));
  }
  if (o.settings) out.settings = { powerPct: o.settings.powerPct, speedMmPerS: o.settings.speedMmPerS };
  return out;
}

export function buildJob(opts: { objects: DocObject[]; pupilId: string; presetId: string; presetVersion?: number; origin: Origin; submit: boolean; now?: Date }): JobDoc {
  const objects = opts.objects.map(toJobObject).filter((o): o is JobObject => o !== null);
  if (!objects.length) throw new Error("There is nothing to send.");
  return {
    schemaVersion: "0.2.0",
    id: "draft", // the server gives every job its own id
    pupilId: opts.pupilId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    status: opts.submit ? "submitted" : "draft",
    preset: { id: opts.presetId, version: opts.presetVersion ?? 1 }, // the server records the current version
    station: null,
    origin: opts.origin,
    objects,
  };
}
