// Build a job document (shared/job.schema.json) from the Editor's objects. Pure.
// Tabs are stored in the Editor as fractions along the outline; the schema wants a distance in bed space
// (after the matrix) from the object's start point, so they are converted here.
import type { DocObject, LayerType, ShapeSettings } from "./doc";
import type { Dimension } from "./dimensions";
import { transformPath, type Matrix, type Path, type Seg } from "./geometry";
import { pathLength, type TabSpec } from "./tabs";

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
  schemaVersion: "0.2.15";
  id: string;
  pupilId: string;
  createdAt: string;
  status: "draft" | "submitted";
  preset: { id: string; version: number };
  station: null;
  origin: Origin;
  objects: JobObject[];
  /** Annotations for people. The server keeps them; they are never cut or sent to the Cutter. */
  dimensions?: JobDimension[];
  /** The class activity this file is for (null: not for any). */
  activityId?: string | null;
}

export type JobDimension =
  | { id: string; kind: "linear"; axis: "aligned" | "horizontal" | "vertical"; a: [number, number]; b: [number, number]; offsetMm: number }
  | { id: string; kind: "radial"; center: [number, number]; radiusMm: number; angleRad: number; diameter: boolean };

export const toJobDimension = (d: Dimension): JobDimension =>
  d.kind === "linear"
    ? { id: d.id, kind: "linear", axis: d.axis, a: [d.a.x, d.a.y], b: [d.b.x, d.b.y], offsetMm: d.offsetMm }
    : { id: d.id, kind: "radial", center: [d.center.x, d.center.y], radiusMm: d.radiusMm, angleRad: d.angleRad, diameter: d.diameter };

export const fromJobDimension = (d: JobDimension): Dimension =>
  d.kind === "linear"
    ? { id: d.id, kind: "linear", axis: d.axis, a: { x: d.a[0], y: d.a[1] }, b: { x: d.b[0], y: d.b[1] }, offsetMm: d.offsetMm }
    : { id: d.id, kind: "radial", center: { x: d.center[0], y: d.center[1] }, radiusMm: d.radiusMm, angleRad: d.angleRad, diameter: d.diameter };

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

export function buildJob(opts: { objects: DocObject[]; dimensions?: Dimension[]; activityId?: string | null; pupilId: string; presetId: string; presetVersion?: number; origin: Origin; submit: boolean; now?: Date }): JobDoc {
  const objects = opts.objects.map(toJobObject).filter((o): o is JobObject => o !== null);
  if (!objects.length) throw new Error("There is nothing to send.");
  return {
    schemaVersion: "0.2.15",
    id: "draft", // the server gives every job its own id
    pupilId: opts.pupilId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    status: opts.submit ? "submitted" : "draft",
    preset: { id: opts.presetId, version: opts.presetVersion ?? 1 }, // the server records the current version
    station: null,
    origin: opts.origin,
    objects,
    ...(opts.activityId !== undefined ? { activityId: opts.activityId } : {}),
    ...(opts.dimensions?.length ? { dimensions: opts.dimensions.map(toJobDimension) } : {}),
  };
}

/** A shape ready to be added to a Doc. */
export interface LoadedShape { path: Path; matrix: Matrix; layer: LayerType; tabs?: TabSpec; settings?: ShapeSettings }

const xy = (p: [number, number]) => ({ x: p[0], y: p[1] });

/** The reverse of toJobObject: a stored job's objects back into Editor shapes. Groups and live text are not stored, so text comes back as plain paths. */
export function fromJobObjects(objects: JobObject[]): LoadedShape[] {
  return objects.map((o) => {
    const segs: Seg[] = o.segments.map((s) =>
      s.type === "line" ? { t: "l", to: xy(s.to) }
      : s.type === "arc" ? { t: "a", c: xy(s.center), to: xy(s.to), ccw: !s.clockwise }
      : { t: "c", c1: xy(s.c1), c2: xy(s.c2), to: xy(s.to) });
    const path: Path = { start: xy(o.start), segs, closed: o.closed };
    const matrix = [...o.matrix] as Matrix;
    const shape: LoadedShape = { path, matrix, layer: o.layer };
    if (o.tabs?.length) {
      const total = pathLength(transformPath(path, matrix));
      if (total > 0) shape.tabs = { widthMm: o.tabs[0]!.widthMm, at: o.tabs.map((t) => t.atLengthMm / total) };
    }
    if (o.settings && o.settings.powerPct !== undefined && o.settings.speedMmPerS !== undefined) shape.settings = { powerPct: o.settings.powerPct, speedMmPerS: o.settings.speedMmPerS };
    return shape;
  });
}
