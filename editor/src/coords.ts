// Coordinate spaces (brief section 5). Design/Bed are mm, Y-up. Screen is px, Y-down.
// Bed -> Screen conversion lives ONLY in this file.

export interface Point {
  x: number;
  y: number;
}

/** Zoom and pan. `originPx` is where bed (0,0) lands on screen; `scale` is px per mm. */
export interface View {
  scale: number;
  originPx: Point;
}

export function bedToScreen(view: View, p: Point): Point {
  return { x: view.originPx.x + p.x * view.scale, y: view.originPx.y - p.y * view.scale };
}

export function screenToBed(view: View, p: Point): Point {
  return { x: (p.x - view.originPx.x) / view.scale, y: (view.originPx.y - p.y) / view.scale };
}

/** View that fits a bed of the given size into a canvas, with a margin in px. */
export function fitView(bedW: number, bedH: number, canvasW: number, canvasH: number, marginPx = 40): View {
  const scale = Math.max(
    Math.min((canvasW - 2 * marginPx) / bedW, (canvasH - 2 * marginPx) / bedH),
    1e-6,
  );
  return {
    scale,
    originPx: { x: (canvasW - bedW * scale) / 2, y: (canvasH + bedH * scale) / 2 },
  };
}

/** Zoom about a screen point, keeping the bed point under it fixed. */
export function zoomAt(view: View, screenPt: Point, factor: number): View {
  const bed = screenToBed(view, screenPt);
  const scale = view.scale * factor;
  return {
    scale,
    originPx: { x: screenPt.x - bed.x * scale, y: screenPt.y + bed.y * scale },
  };
}
