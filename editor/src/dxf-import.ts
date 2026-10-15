// DXF import (ASCII). Handles LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE/VERTEX and SPLINE.
// Everything is converted to mm. No clean-up here: duplicate/overlap removal and joining are Server work.
import type { Point } from "./coords";
import type { LayerType } from "./doc";
import { boundsOf, type Path, type Seg } from "./geometry";

export interface ImportedShape {
  path: Path;
  layer: LayerType;
  dxfLayer: string;
}

export interface ImportResult {
  shapes: ImportedShape[];
  /** $INSUNITS from the header; null if absent or 0 (unitless) -> caller must ask the user. */
  insunits: number | null;
  skipped: Record<string, number>;
}

const UNIT_TO_MM: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4 };

/** Onshape exports centimetres and often omits $INSUNITS, so a file without units is assumed to be cm. */
export const DEFAULT_MM_PER_UNIT = 10;

/** Millimetres per DXF unit for an $INSUNITS value, or null if unknown. */
export function mmPerUnit(insunits: number | null): number | null {
  return insunits === null ? null : (UNIT_TO_MM[insunits] ?? null);
}

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i]!.trim(), 10), lines[i + 1]!.trim()]);
  return out;
}

interface Entity { type: string; layer: string; colour: number | null; p: Pair[] }

function entities(all: Pair[]): { list: Entity[]; insunits: number | null } {
  let insunits: number | null = null;
  const list: Entity[] = [];
  let section = "";
  let cur: Entity | null = null;
  for (let i = 0; i < all.length; i++) {
    const [code, val] = all[i]!;
    if (code === 0 && val === "SECTION") { section = all[i + 1]?.[1] ?? ""; continue; }
    if (code === 0 && val === "ENDSEC") { cur = null; section = ""; continue; }
    if (section === "HEADER" && code === 9 && val === "$INSUNITS") {
      const v = parseInt(all[i + 1]?.[1] ?? "", 10);
      insunits = Number.isFinite(v) && v > 0 ? v : null;
    }
    if (section !== "ENTITIES") continue;
    if (code === 0) { cur = { type: val, layer: "0", colour: null, p: [] }; list.push(cur); }
    else if (cur) {
      if (code === 8) cur.layer = val;
      else if (code === 62) cur.colour = parseInt(val, 10);
      else cur.p.push([code, val]);
    }
  }
  return { list, insunits };
}

const f = (e: Entity, code: number, def = 0): number => {
  const hit = e.p.find(([c]) => c === code);
  return hit ? parseFloat(hit[1]) : def;
};
const all = (e: Entity, code: number): number[] => e.p.filter(([c]) => c === code).map(([, v]) => parseFloat(v));
const rad = (d: number) => (d * Math.PI) / 180;

/** Arc/bulge segment between two points. bulge = tan(theta/4), + = counter-clockwise. */
function bulgeSeg(a: Point, b: Point, bulge: number): Seg {
  if (Math.abs(bulge) < 1e-12) return { t: "l", to: b };
  const theta = 4 * Math.atan(bulge);
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (d < 1e-12) return { t: "l", to: b };
  const h = d / 2 / Math.tan(theta / 2); // signed distance of centre to the left of a->b
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  return { t: "a", c: { x: mx + (-(b.y - a.y) / d) * h, y: my + ((b.x - a.x) / d) * h }, to: b, ccw: bulge > 0 };
}

function polyline(vs: { p: Point; bulge: number }[], closed: boolean): Path | null {
  if (vs.length < 2) return null;
  const segs: Seg[] = [];
  const n = closed ? vs.length : vs.length - 1;
  for (let i = 0; i < n; i++) segs.push(bulgeSeg(vs[i]!.p, vs[(i + 1) % vs.length]!.p, vs[i]!.bulge));
  if (closed) {
    // Last segment returns to the start; drop it if it is degenerate.
    const last = segs[segs.length - 1]!;
    if (last.t === "l" && Math.hypot(last.to.x - vs[0]!.p.x, last.to.y - vs[0]!.p.y) < 1e-12 && vs.length > 2 && Math.hypot(vs[vs.length - 1]!.p.x - vs[0]!.p.x, vs[vs.length - 1]!.p.y - vs[0]!.p.y) < 1e-12) segs.pop();
  }
  return { start: vs[0]!.p, segs, closed };
}

function bsplinePoints(e: Entity): Point[] {
  const degree = f(e, 71, 3);
  const knots = all(e, 40);
  const xs = all(e, 10), ys = all(e, 20);
  const ctrl = xs.map((x, i) => ({ x, y: ys[i] ?? 0 }));
  const fx = all(e, 11), fy = all(e, 21);
  const fit = fx.map((x, i) => ({ x, y: fy[i] ?? 0 }));
  if (ctrl.length < degree + 1 || knots.length !== ctrl.length + degree + 1) return fit.length >= 2 ? fit : ctrl;
  const t0 = knots[degree]!, t1 = knots[ctrl.length]!;
  const pts: Point[] = [];
  const N = Math.max(32, ctrl.length * 8);
  for (let s = 0; s <= N; s++) {
    const t = Math.min(t0 + ((t1 - t0) * s) / N, t1 - 1e-12 * (s === N ? 1 : 0));
    let k = degree;
    while (k < ctrl.length - 1 && t >= knots[k + 1]!) k++;
    const d = ctrl.slice(k - degree, k + 1).map((q) => ({ ...q }));
    for (let r = 1; r <= degree; r++)
      for (let j = degree; j >= r; j--) {
        const den = knots[j + 1 + k - r]! - knots[j + k - degree]!;
        const a = den === 0 ? 0 : (t - knots[j + k - degree]!) / den;
        d[j] = { x: (1 - a) * d[j - 1]!.x + a * d[j]!.x, y: (1 - a) * d[j - 1]!.y + a * d[j]!.y };
      }
    pts.push(d[degree]!);
  }
  return pts;
}

function toPath(e: Entity, verts: Entity[]): Path | null {
  switch (e.type) {
    case "LINE":
      return { start: { x: f(e, 10), y: f(e, 20) }, segs: [{ t: "l", to: { x: f(e, 11), y: f(e, 21) } }], closed: false };
    case "ARC": {
      const c = { x: f(e, 10), y: f(e, 20) }, r = f(e, 40);
      const a0 = rad(f(e, 50)), a1 = rad(f(e, 51));
      if (r <= 0) return null;
      return {
        start: { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) },
        segs: [{ t: "a", c, to: { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) }, ccw: true }],
        closed: false,
      };
    }
    case "CIRCLE": {
      const c = { x: f(e, 10), y: f(e, 20) }, r = f(e, 40);
      if (r <= 0) return null;
      return {
        start: { x: c.x + r, y: c.y },
        segs: [
          { t: "a", c, to: { x: c.x - r, y: c.y }, ccw: true },
          { t: "a", c, to: { x: c.x + r, y: c.y }, ccw: true },
        ],
        closed: true,
      };
    }
    case "LWPOLYLINE": {
      const vs: { p: Point; bulge: number }[] = [];
      for (const [code, val] of e.p) {
        if (code === 10) vs.push({ p: { x: parseFloat(val), y: 0 }, bulge: 0 });
        else if (code === 20 && vs.length) vs[vs.length - 1]!.p.y = parseFloat(val);
        else if (code === 42 && vs.length) vs[vs.length - 1]!.bulge = parseFloat(val);
      }
      return polyline(vs, (f(e, 70) & 1) === 1);
    }
    case "POLYLINE":
      return polyline(verts.map((v) => ({ p: { x: f(v, 10), y: f(v, 20) }, bulge: f(v, 42) })), (f(e, 70) & 1) === 1);
    case "SPLINE": {
      const pts = bsplinePoints(e);
      if (pts.length < 2) return null;
      const closed = (f(e, 70) & 1) === 1;
      return { start: pts[0]!, segs: pts.slice(1).map((to): Seg => ({ t: "l", to })), closed };
    }
    default:
      return null;
  }
}

/** Ignore for a layer whose name contains "ignore"; Score for "score" or ACI colour 5 (blue) / 4 (cyan). Everything else is Cut. */
export function layerFor(dxfLayer: string, colour: number | null): LayerType {
  if (/ignore/i.test(dxfLayer)) return "ignore";
  if (/score/i.test(dxfLayer)) return "score";
  if (colour === 5 || colour === 4) return "score";
  return "cut";
}

export function parseDXF(text: string): ImportResult {
  const { list, insunits } = entities(pairs(text));
  const shapes: ImportedShape[] = [];
  const skipped: Record<string, number> = {};
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.type === "VERTEX" || e.type === "SEQEND") continue;
    let verts: Entity[] = [];
    if (e.type === "POLYLINE") {
      let j = i + 1;
      while (j < list.length && list[j]!.type === "VERTEX") verts.push(list[j++]!);
    }
    const path = toPath(e, verts);
    if (path) shapes.push({ path, layer: layerFor(e.layer, e.colour), dxfLayer: e.layer });
    else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  }
  return { shapes, insunits, skipped };
}

/** Scale a path from file units to mm. */
export function scalePath(path: Path, k: number): Path {
  if (k === 1) return path;
  const s = (p: Point): Point => ({ x: p.x * k, y: p.y * k });
  return {
    start: s(path.start),
    closed: path.closed,
    segs: path.segs.map((g): Seg => (g.t === "l" ? { t: "l", to: s(g.to) } : g.t === "a" ? { t: "a", c: s(g.c), to: s(g.to), ccw: g.ccw } : { t: "c", c1: s(g.c1), c2: s(g.c2), to: s(g.to) })),
  };
}

/** Bottom-left of the combined bounding box. */
export function designMin(paths: Path[]): Point {
  const bs = paths.map(boundsOf);
  return { x: Math.min(...bs.map((b) => b.minX)), y: Math.min(...bs.map((b) => b.minY)) };
}
