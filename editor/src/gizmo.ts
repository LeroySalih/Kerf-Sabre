// Gimbal: on-canvas handles for moving along an axis, scaling and rotating the selection.
// Layout and hit-testing are in screen px (Y-down); the transform maths are in bed mm (Y-up).
import type { Point } from "./coords";
import type { Matrix } from "./geometry";

export type Handle = "move" | "move-x" | "move-y" | "scale-x" | "scale-y" | "scale" | "rotate";

/** Pixel layout around the pivot. */
export const GIZMO = {
  arrow: 80, // arrow tip distance along each axis
  scaleAt: 48, // axis scale squares sit this far along the axis
  diag: 34, // uniform scale square sits at (diag, -diag)
  ring: 104, // rotation ring radius
  centre: 8, // free-move square half-size
  square: 6, // scale square half-size
  tip: 11, // arrow tip hit radius
  line: 5, // shaft / ring hit half-width
} as const;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Handle positions on screen for a pivot at `p` (screen px). Screen Y grows downwards, so "up" is -y. */
export function gizmoPoints(p: Point) {
  return {
    centre: p,
    tipX: { x: p.x + GIZMO.arrow, y: p.y },
    tipY: { x: p.x, y: p.y - GIZMO.arrow },
    scaleX: { x: p.x + GIZMO.scaleAt, y: p.y },
    scaleY: { x: p.x, y: p.y - GIZMO.scaleAt },
    scaleUniform: { x: p.x + GIZMO.diag, y: p.y - GIZMO.diag },
  };
}

const inSquare = (pt: Point, c: Point, half: number) => Math.abs(pt.x - c.x) <= half && Math.abs(pt.y - c.y) <= half;

/** Which handle is under `pt` (screen px) for a pivot at `p`, or null. Small handles win over the long shafts and ring. */
export function hitGizmo(p: Point, pt: Point): Handle | null {
  const g = gizmoPoints(p);
  if (inSquare(pt, g.centre, GIZMO.centre)) return "move";
  if (inSquare(pt, g.scaleUniform, GIZMO.square + 1)) return "scale";
  if (inSquare(pt, g.scaleX, GIZMO.square)) return "scale-x";
  if (inSquare(pt, g.scaleY, GIZMO.square)) return "scale-y";
  if (dist(pt, g.tipX) <= GIZMO.tip) return "move-x";
  if (dist(pt, g.tipY) <= GIZMO.tip) return "move-y";
  if (Math.abs(pt.y - p.y) <= GIZMO.line && pt.x > p.x && pt.x < g.tipX.x) return "move-x"; // shaft
  if (Math.abs(pt.x - p.x) <= GIZMO.line && pt.y < p.y && pt.y > g.tipY.y) return "move-y";
  if (Math.abs(dist(pt, p) - GIZMO.ring) <= GIZMO.line) return "rotate";
  return null;
}

const rotateAbout = (pivot: Point, rad: number): Matrix => {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, pivot.x - c * pivot.x + s * pivot.y, pivot.y - s * pivot.x - c * pivot.y];
};
const scaleAbout = (pivot: Point, sx: number, sy: number): Matrix => [sx, 0, 0, sy, pivot.x - sx * pivot.x, pivot.y - sy * pivot.y];

export interface DragOptions {
  /** Round rotation to 15 degree steps. */
  step?: boolean;
}

const MIN_SCALE = 0.01;
const signedClamp = (f: number) => (Math.abs(f) < MIN_SCALE ? (f < 0 ? -MIN_SCALE : MIN_SCALE) : f);

/**
 * Total transform since the drag began, for dragging `handle` from `start` to `cur` (bed mm) about `pivot`.
 * Apply it to each object's matrix as it was at drag start. Null when the drag can't define a transform.
 */
export function gizmoMatrix(handle: Handle, pivot: Point, start: Point, cur: Point, opts: DragOptions = {}): Matrix | null {
  switch (handle) {
    case "move": return [1, 0, 0, 1, cur.x - start.x, cur.y - start.y];
    case "move-x": return [1, 0, 0, 1, cur.x - start.x, 0];
    case "move-y": return [1, 0, 0, 1, 0, cur.y - start.y];
    case "scale-x": {
      const d = start.x - pivot.x;
      return Math.abs(d) < 1e-9 ? null : scaleAbout(pivot, signedClamp((cur.x - pivot.x) / d), 1);
    }
    case "scale-y": {
      const d = start.y - pivot.y;
      return Math.abs(d) < 1e-9 ? null : scaleAbout(pivot, 1, signedClamp((cur.y - pivot.y) / d));
    }
    case "scale": {
      const d = dist(start, pivot);
      if (d < 1e-9) return null;
      const f = Math.max(MIN_SCALE, dist(cur, pivot) / d);
      return scaleAbout(pivot, f, f);
    }
    case "rotate": return rotateAbout(pivot, gizmoAngle(pivot, start, cur, opts) * (Math.PI / 180));
  }
}

/** Rotation in degrees (counter-clockwise +, bed space) from `start` to `cur` about `pivot`. */
export function gizmoAngle(pivot: Point, start: Point, cur: Point, opts: DragOptions = {}): number {
  let a = (Math.atan2(cur.y - pivot.y, cur.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x)) * (180 / Math.PI);
  a = ((a + 540) % 360) - 180; // shortest way round, (-180, 180]
  return opts.step ? Math.round(a / 15) * 15 : a;
}
