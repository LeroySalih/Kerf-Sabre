// Bed bounds check. Anything outside the bed is shown red and must block job submission.
import type { DocObject } from "./doc";
import { boundsOf, transformPath } from "./geometry";

export interface BedSize { widthMm: number; heightMm: number }

/** Ids of objects whose geometry leaves [0,W] x [0,H] in bed space (tolerance in mm). */
export function outOfBounds(objects: DocObject[], bed: BedSize, tolMm = 1e-6): number[] {
  return objects
    .filter((o) => {
      const b = boundsOf(transformPath(o.path, o.matrix));
      return b.minX < -tolMm || b.minY < -tolMm || b.maxX > bed.widthMm + tolMm || b.maxY > bed.heightMm + tolMm;
    })
    .map((o) => o.id);
}

/** A job may be submitted only if it has something to cut and everything is on the bed. */
export function canSubmit(objects: DocObject[], bed: BedSize): boolean {
  return objects.length > 0 && outOfBounds(objects, bed).length === 0;
}
