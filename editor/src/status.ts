// Footer bar text.
import type { Bounds } from "./geometry";

const f = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Horizontal and vertical extent of the selection, e.g. "2 selected  |  Width 73.90 mm  |  Height 44.34 mm". */
export function selectionSummary(count: number, b: Bounds | null): string {
  if (!b || count === 0) return "Nothing selected";
  const what = count === 1 ? "1 object" : `${count} objects`;
  return `${what} selected  |  Width ${f(b.maxX - b.minX)} mm  |  Height ${f(b.maxY - b.minY)} mm`;
}
