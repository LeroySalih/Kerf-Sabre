// Open paths: a shape on the Cut layer that is not closed cuts a line, not a part, so nothing drops out. The Check Open Paths tool marks the free
// ends with red dots, and sending a file warns when there are any. (An open line on the Score layer is normal; the Ignore layer is never cut.)
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { apply } from "./geometry";

export interface OpenEnd { x: number; y: number; layer: "cut" | "score"; objectId: number }

/** The open shapes that are cut or scored (the Ignore layer is never looked at). */
export const openPaths = (objects: DocObject[]): DocObject[] => objects.filter((o) => !o.path.closed && o.layer !== "ignore" && o.path.segs.length > 0);

/** How many open shapes are on the Cut layer, where it matters. */
export const openCutCount = (objects: DocObject[]): number => openPaths(objects).filter((o) => o.layer === "cut").length;

/** Where each open shape starts and ends, in bed mm (after the shape's placement). */
export function openEnds(objects: DocObject[]): OpenEnd[] {
  const out: OpenEnd[] = [];
  for (const o of openPaths(objects)) {
    const last = o.path.segs[o.path.segs.length - 1]!.to;
    for (const p of [o.path.start, last] as Point[]) {
      const q = apply(o.matrix, p);
      out.push({ x: q.x, y: q.y, layer: o.layer as "cut" | "score", objectId: o.id });
    }
  }
  return out;
}

/** The words for the tool's result and for the warning before sending. */
export function describeOpen(objects: DocObject[]): string {
  const ps = openPaths(objects);
  const cut = ps.filter((o) => o.layer === "cut").length, score = ps.length - cut;
  if (!ps.length) return "No open paths: every shape is closed.";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [] as string[];
  if (cut) parts.push(`${plural(cut, "open path")} on the Cut layer (large red dots): they would cut a line, not a part`);
  if (score) parts.push(`${plural(score, "open line")} on the Score layer (small red rings): these are fine`);
  return parts.join("; ") + ".";
}
