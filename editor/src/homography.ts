// Planar homographies (3x3, row-major, 9 numbers). Used to map the camera picture (pixels, Y down) onto the bed (mm, Y up).
export interface Pt { x: number; y: number }
export type H = number[];

/** The homography that maps each `from` point to its `to` point (4 points, direct linear transform). null if the points are degenerate (e.g. three in a line). */
export function solveHomography(from: Pt[], to: Pt[]): H | null {
  if (from.length !== 4 || to.length !== 4) return null;
  // unknowns h0..h7 with h8 = 1; two equations per point
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!, { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-10) return null;
    [a[c], a[p]] = [a[p]!, a[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let k = c; k <= n; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  const h = a.map((row, i) => row[n]! / row[i]!);
  const out = [...h, 1];
  return out.every(Number.isFinite) ? out : null;
}

export function applyH(h: H, p: Pt): Pt {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  return { x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w, y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w };
}

export function invertH(h: H): H | null {
  const [a, b, c, d, e, f, g, i, j] = h as [number, number, number, number, number, number, number, number, number];
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv = [A, -(b * j - c * i), b * f - c * e, B, a * j - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d].map((v) => v / det);
  const s = inv[8]!;
  return Math.abs(s) > 1e-14 ? inv.map((v) => v / s) : inv;
}
