// Consolidating pupils' files into one cut. A teacher picks a class, sees the files waiting in the queue for it, and imports the ones they choose
// into the open file. Each pupil file comes in as ONE GROUP (so it can be selected, moved and turned as a unit), laid out in rows on the bed so
// they do not sit on top of each other, optionally with a name label above it on the Ignore layer (never cut).
import type { Doc, DocObject } from "./doc";
import { boundsOf, multiply, translation, transformPath, type Bounds, type Path } from "./geometry";
import { fromJobObjects, type LoadedShape } from "./job";
import type { ClassPupil, JobSummary } from "./server";
import { pupilLabel } from "./server";
import { textToPaths } from "./text";

/** The states "in the queue for the group": waiting for approval, or approved and waiting for a laser. */
export const QUEUE_STATES = ["submitted", "approved"] as const;
export const QUEUE_QUERY = QUEUE_STATES.join(",");

/** The files in the queue that belong to this class's pupils, in pupil order then oldest first. */
export function filesForClass(jobs: JobSummary[], pupils: readonly (ClassPupil | string)[]): JobSummary[] {
  const ids = new Set(pupils.map((p) => (typeof p === "string" ? p : p.pupilId)));
  return jobs
    .filter((j) => (QUEUE_STATES as readonly string[]).includes(j.status) && !!j.pupilId && ids.has(j.pupilId))
    .sort((a, b) => who(a).localeCompare(who(b)) || a.createdAt.localeCompare(b.createdAt));
}

export const who = (j: Pick<JobSummary, "pupilId" | "pupilName">): string => pupilLabel(j.pupilId ?? "?", j.pupilName);

const size = (j: JobSummary): string => (j.estimate?.extentMm ? `${Math.round(j.estimate.extentMm.widthMm)} × ${Math.round(j.estimate.extentMm.heightMm)} mm` : "");

/** One line for the list: who, where it is in the queue, how big, what material. */
export function describeFile(j: JobSummary, materialName: (id: string) => string = (id) => id): string {
  const where = j.status === "approved" ? (j.ticket != null ? `ticket ${j.ticket}` : "approved") : "waiting for approval";
  return [who(j), where, size(j), materialName(j.preset.id)].filter(Boolean).join(" · ");
}

/** A warning when the chosen files are for different materials: a cut uses one material. Empty when they agree (or fewer than two). */
export function materialWarning(jobs: JobSummary[], materialName: (id: string) => string = (id) => id): string {
  const names = [...new Set(jobs.map((j) => materialName(j.preset.id)))];
  return names.length > 1 ? `These files use different materials (${names.join(", ")}). A cut uses one material, so check they should go on the same sheet.` : "";
}

export interface Box { w: number; h: number }
export interface Placed { x: number; y: number }

/**
 * Lay boxes out left to right in rows (a shelf pack) on a bed, `gap` apart, starting `margin` in from the origin. Returns each box's lower-left
 * corner, in the order given, and whether everything fits on the bed. A box too wide for a row starts its own row; the layout carries on past
 * the bed's edge rather than refusing, so the teacher can move things.
 */
export function planLayout(boxes: Box[], bed: { widthMm: number; heightMm: number }, gap = 8, margin = 10): { at: Placed[]; fits: boolean } {
  const at: Placed[] = [];
  let x = margin, y = margin, rowH = 0, fits = true;
  for (const b of boxes) {
    if (x > margin && x + b.w > bed.widthMm - margin) { x = margin; y += rowH + gap; rowH = 0; }
    at.push({ x, y });
    if (x + b.w > bed.widthMm - margin + 1e-9 || y + b.h > bed.heightMm - margin + 1e-9) fits = false;
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return { at, fits };
}

const union = (bs: Bounds[]): Bounds => ({ minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)), maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)) });

const LABEL_MM = 5, LABEL_GAP_MM = 2;
const LABEL_FONT = "hershey-futural"; // single-line

interface Piece { path: Path; layer: LoadedShape["layer"]; matrix: DocObject["matrix"]; tabs?: LoadedShape["tabs"]; settings?: LoadedShape["settings"] }

/** One pupil file as shapes in bed space with its bounding box (the label, if any, included). */
function pieceSet(job: JobSummary, label: boolean): { pieces: Piece[]; box: Bounds } | null {
  const shapes = fromJobObjects(job.objects);
  if (!shapes.length) return null;
  const pieces: Piece[] = shapes.map((s) => ({ path: s.path, layer: s.layer, matrix: s.matrix, tabs: s.tabs, settings: s.settings }));
  const body = union(pieces.map((p) => boundsOf(transformPath(p.path, p.matrix))));
  if (label) {
    const paths = textToPaths({ content: who(job), font: LABEL_FONT, sizeMm: LABEL_MM });
    if (paths.length) {
      const lb = union(paths.map(boundsOf));
      const dx = body.minX - lb.minX, dy = body.maxY + LABEL_GAP_MM - lb.minY; // left-aligned, just above the file
      for (const p of paths) pieces.push({ path: p, layer: "ignore", matrix: translation(dx, dy) });
    }
  }
  return { pieces, box: union(pieces.map((p) => boundsOf(transformPath(p.path, p.matrix)))) };
}

export interface ImportResult { ids: number[]; groups: number; skipped: string[]; fits: boolean }

/**
 * Add the chosen files to the document, each as one group, laid out in rows on the bed. Returns the new object ids (so the caller can select them).
 * A file with nothing in it is skipped. If the document had no material chosen by the caller, the caller sets it; this does not touch it.
 */
export function addFilesToDoc(doc: Doc, jobs: JobSummary[], opts: { labels: boolean; bed: { widthMm: number; heightMm: number } }): ImportResult {
  const sets = jobs.map((j) => ({ job: j, set: pieceSet(j, opts.labels) }));
  const usable = sets.filter((s): s is { job: JobSummary; set: NonNullable<typeof s.set> } => s.set !== null);
  const layout = planLayout(usable.map((u) => ({ w: u.set.box.maxX - u.set.box.minX, h: u.set.box.maxY - u.set.box.minY })), opts.bed);
  const ids: number[] = [];
  usable.forEach((u, i) => {
    const group = doc.state.nextGroup++;
    const move = translation(layout.at[i]!.x - u.set.box.minX, layout.at[i]!.y - u.set.box.minY);
    for (const p of u.set.pieces) {
      const o = doc.add(p.path, multiply(move, p.matrix), p.layer);
      o.group = group;
      if (p.tabs) o.tabs = p.tabs;
      if (p.settings) o.settings = p.settings;
      ids.push(o.id);
    }
  });
  return { ids, groups: usable.length, skipped: sets.filter((s) => s.set === null).map((s) => who(s.job)), fits: layout.fits };
}
