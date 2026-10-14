// Align and distribute. A unit is a shape or a whole group (groups move as one). Bed space is Y-up: "top" is max Y.
import type { Point } from "./coords";
import type { Bounds } from "./geometry";

export type AlignKind = "left" | "centre" | "right" | "top" | "middle" | "bottom";

export interface Unit {
  ids: number[];
  bounds: Bounds;
}

const mid = (a: number, b: number) => (a + b) / 2;

/** Translation for each unit so it lines up with `ref` on the given edge or centre. */
export function alignDeltas(units: Unit[], kind: AlignKind, ref: Bounds): Point[] {
  return units.map(({ bounds: b }) => {
    switch (kind) {
      case "left": return { x: ref.minX - b.minX, y: 0 };
      case "right": return { x: ref.maxX - b.maxX, y: 0 };
      case "centre": return { x: mid(ref.minX, ref.maxX) - mid(b.minX, b.maxX), y: 0 };
      case "top": return { x: 0, y: ref.maxY - b.maxY };
      case "bottom": return { x: 0, y: ref.minY - b.minY };
      case "middle": return { x: 0, y: mid(ref.minY, ref.maxY) - mid(b.minY, b.maxY) };
    }
  });
}

/** Union of the units' bounds. */
export function unionBounds(units: Unit[]): Bounds {
  return {
    minX: Math.min(...units.map((u) => u.bounds.minX)), maxX: Math.max(...units.map((u) => u.bounds.maxX)),
    minY: Math.min(...units.map((u) => u.bounds.minY)), maxY: Math.max(...units.map((u) => u.bounds.maxY)),
  };
}

/**
 * Space units so the gaps between neighbours are equal. The two outermost units stay put.
 * Returns one translation per input unit (in input order). Needs 3 or more units; otherwise all zero.
 */
export function distributeDeltas(units: Unit[], axis: "h" | "v"): Point[] {
  const zero = units.map(() => ({ x: 0, y: 0 }));
  if (units.length < 3) return zero;
  const lo = (u: Unit) => (axis === "h" ? u.bounds.minX : u.bounds.minY);
  const size = (u: Unit) => (axis === "h" ? u.bounds.maxX - u.bounds.minX : u.bounds.maxY - u.bounds.minY);
  const order = units.map((_, i) => i).sort((a, b) => lo(units[a]!) - lo(units[b]!));
  const first = units[order[0]!]!, last = units[order[order.length - 1]!]!;
  const span = lo(last) + size(last) - lo(first);
  const gap = (span - order.reduce((s, i) => s + size(units[i]!), 0)) / (units.length - 1);
  const out = zero;
  let pos = lo(first);
  for (const i of order) {
    const d = pos - lo(units[i]!);
    out[i] = axis === "h" ? { x: d, y: 0 } : { x: 0, y: d };
    pos += size(units[i]!) + gap;
  }
  return out;
}
