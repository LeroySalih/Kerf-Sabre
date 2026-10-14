// Finger-joint box generator: the flat panels of a box whose edges interlock with square fingers. Pure: returns Cut
// shapes in design space (mm, Y-up), laid out in rows; the caller places them. Dimensions are the OUTSIDE size.
//
// Every panel is its full footprint (a wall is W x H, so it reaches the outer face of its neighbours) with t-deep
// notches cut where the neighbour owns the corner column. Ownership rules, so nothing overlaps and nothing is left out:
//  - The base (and the lid, if there is one) own the four corner cubes at their level; the walls are cut there.
//  - Along a wall/base (or wall/lid) edge the middle is split into an odd number of cells: the wall owns the first,
//    third, ... and the base owns the second, fourth, ... (so both ends of the middle belong to the wall).
//  - Along a vertical corner the same, with the front and back walls owning the first, third, ... cells (from the base).
// The back wall is identical to the front, and the right wall to the left, so each is listed twice.
import type { Point } from "./coords";
import { polylinePath, translation, transformPath, type Path } from "./geometry";
import type { TestItem } from "./testgrid";

export interface FingerBoxParams {
  widthMm: number; // X, outside
  depthMm: number; // Y, outside
  heightMm: number; // Z, outside
  thicknessMm: number; // material thickness
  fingerMm: number; // target finger width (the actual width is adjusted so a whole odd number fit)
  lid: boolean; // closed box with a fingered lid; otherwise open-topped
}

export function validateFingerBox(p: FingerBoxParams): string | null {
  if (!(p.thicknessMm > 0) || p.thicknessMm > 20) return "Material thickness must be above 0 and at most 20 mm.";
  if (!(p.fingerMm >= 3) || p.fingerMm < p.thicknessMm) return "Fingers must be at least 3 mm wide, and no narrower than the material is thick.";
  const min = Math.max(20, 5 * p.thicknessMm);
  if (![p.widthMm, p.depthMm, p.heightMm].every((n) => n >= min)) return `Width, depth and height must each be at least ${Math.round(min * 10) / 10} mm for this thickness.`;
  return null;
}

/** Odd number of cells across `len`, as close to `len / target` as possible (at least 1). */
export function cellCount(len: number, target: number): number {
  const n = Math.max(1, Math.round(len / target));
  if (n % 2 === 1) return n;
  return Math.abs(len / target - (n - 1)) <= Math.abs(len / target - (n + 1)) ? Math.max(1, n - 1) : n + 1;
}

type Interval = [number, number];

/** The cells of an odd split of [lo, hi] with the given parity (0 = first, third, ...; 1 = second, ...). */
function cells(lo: number, hi: number, target: number, parity: 0 | 1): Interval[] {
  const m = cellCount(hi - lo, target);
  const w = (hi - lo) / m;
  const out: Interval[] = [];
  for (let i = parity; i < m; i += 2) out.push([lo + i * w, lo + (i + 1) * w]);
  return out;
}

interface Edge {
  notches: Interval[]; // t-deep cuts along the edge, as distances from the edge's start (counter-clockwise)
}
interface Panel {
  w: number;
  h: number;
  /** Order: bottom (left to right), right (up), top (right to left), left (down). */
  edges: [Edge, Edge, Edge, Edge];
  /** Corner squares cut away: bottom-left, bottom-right, top-right, top-left. */
  corners: [boolean, boolean, boolean, boolean];
}

const mirror = (ivs: Interval[], len: number): Interval[] => ivs.map(([a, b]): Interval => [len - b, len - a]).reverse();

/** Outline of a panel: its rectangle with notches of depth t along the edges and t x t corner squares removed. */
function outline(panel: Panel, t: number): Path {
  const { w, h, edges, corners } = panel;
  const lens = [w, h, w, h];
  // Edge-local (s along, d inward) to panel coordinates, walking counter-clockwise.
  const toPoint: ((s: number, d: number) => Point)[] = [
    (s, d) => ({ x: s, y: d }),
    (s, d) => ({ x: w - d, y: s }),
    (s, d) => ({ x: w - s, y: h - d }),
    (s, d) => ({ x: d, y: h - s }),
  ];
  const innerCorner: Point[] = [{ x: t, y: t }, { x: w - t, y: t }, { x: w - t, y: h - t }, { x: t, y: h - t }];
  const pts: Point[] = [];
  for (let e = 0; e < 4; e++) {
    // corners[] is indexed by the corner at the START of edge e: bl, br, tr, tl for e = 0..3
    const cutStart = corners[e]!, cutEnd = corners[(e + 1) % 4]!;
    const len = lens[e]!;
    const c0 = cutStart ? t : 0, c1 = len - (cutEnd ? t : 0);
    if (cutStart) pts.push(innerCorner[e]!);
    let cursor = c0;
    for (const [a0, b0] of [...edges[e]!.notches].sort((x, y) => x[0] - y[0])) {
      const a = Math.max(a0, c0), b = Math.min(b0, c1);
      if (b <= a) continue;
      if (a > cursor) pts.push(toPoint[e]!(cursor, 0), toPoint[e]!(a, 0));
      pts.push(toPoint[e]!(a, t), toPoint[e]!(b, t));
      cursor = b;
    }
    if (cursor < c1) pts.push(toPoint[e]!(cursor, 0), toPoint[e]!(c1, 0));
    if (!cutEnd) pts.push(toPoint[e]!(len, 0));
  }
  // Drop repeated and collinear points.
  const eq = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  let clean = pts.filter((q, i) => !eq(q, pts[(i + pts.length - 1) % pts.length]!));
  clean = clean.filter((q, i) => {
    const a = clean[(i + clean.length - 1) % clean.length]!, b = clean[(i + 1) % clean.length]!;
    return Math.abs((q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x)) > 1e-9;
  });
  return polylinePath(clean, true)!;
}

export type PanelName = "base" | "lid" | "front" | "back" | "left" | "right";

/** The panels with their outlines at the origin (before layout), in the order base, lid, front, back, left, right. */
export function fingerBoxPanels(p: FingerBoxParams): { name: PanelName; path: Path; w: number; h: number }[] {
  const { widthMm: W, depthMm: D, heightMm: H, thicknessMm: t, fingerMm: f } = p;
  const none: Edge = { notches: [] };

  // Base / lid: the wall owns even cells of each edge's middle, so the base is cut there.
  const along = (len: number): Edge => ({ notches: cells(t, len - t, f, 0) });
  const plate = (w: number, h: number): Panel => ({ w, h, edges: [along(w), along(h), along(w), along(h)], corners: [false, false, false, false] });

  // Walls: cut at the odd cells where they meet the base or lid, and corner squares where the base or lid owns them.
  const zLo = t, zHi = p.lid ? H - t : H;
  const wall = (w: number, vertical: 0 | 1): Panel => {
    const joint: Edge = { notches: cells(t, w - t, f, 1) };
    // Vertical edges are measured from the bottom (z); the left edge runs downward, so mirror it.
    const up = cells(zLo, zHi, f, vertical);
    return {
      w, h: H,
      edges: [joint, { notches: up }, p.lid ? joint : none, { notches: mirror(up, H) }],
      corners: [true, true, !!p.lid, !!p.lid],
    };
  };
  // Front/back own the even cells of a vertical corner (so they are cut at the odd ones); left/right the reverse.
  const front = wall(W, 1), side = wall(D, 0);

  const panels: { name: PanelName; panel: Panel }[] = [
    { name: "base", panel: plate(W, D) },
    ...(p.lid ? [{ name: "lid" as const, panel: plate(W, D) }] : []),
    { name: "front", panel: front }, { name: "back", panel: front },
    { name: "left", panel: side }, { name: "right", panel: side },
  ];
  return panels.map(({ name, panel }) => ({ name, path: outline(panel, t), w: panel.w, h: panel.h }));
}

/** All the panels laid out in rows (front and back, then left and right, then base and lid), 5 mm apart. */
export function fingerBox(p: FingerBoxParams): TestItem[] {
  const gap = 5;
  const panels = fingerBoxPanels(p);
  const rows: (typeof panels)[] = [
    panels.filter((q) => q.name === "front" || q.name === "back"),
    panels.filter((q) => q.name === "left" || q.name === "right"),
    panels.filter((q) => q.name === "base" || q.name === "lid"),
  ];
  const out: TestItem[] = [];
  let y = 0;
  for (const row of rows) {
    let x = 0;
    for (const q of row) {
      out.push({ path: transformPath(q.path, translation(x, y)), layer: "cut" });
      x += q.w + gap;
    }
    y += row[0]!.h + gap;
  }
  return out;
}
