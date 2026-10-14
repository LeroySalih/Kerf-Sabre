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

const mul3 = (a: H, b: H): H => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));

/** Move the points' centre to the origin and scale them to a mean distance of sqrt(2): keeps the fit well conditioned. */
function normaliser(pts: Pt[]): { t: H; out: Pt[] } {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  const k = d > 1e-12 ? Math.SQRT2 / d : 1;
  return { t: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], out: pts.map((p) => ({ x: (p.x - cx) * k, y: (p.y - cy) * k })) };
}

/** The homography that best maps `from` onto `to` in the least-squares sense (4 or more points; exactly 4 is solved exactly). null if degenerate. */
export function solveHomographyLS(from: Pt[], to: Pt[]): H | null {
  if (from.length !== to.length || from.length < 4) return null;
  if (from.length === 4) return solveHomography(from, to);
  const f = normaliser(from), t = normaliser(to);
  // normal equations of the same 2n x 8 system (h8 = 1), solved by Gauss-Jordan
  const n = 8, m: number[][] = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  const add = (row: number[], rhs: number) => { for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) m[i]![j]! += row[i]! * row[j]!; m[i]![n]! += row[i]! * rhs; } };
  f.out.forEach((p, i) => {
    const { x: u, y: v } = t.out[i]!;
    add([p.x, p.y, 1, 0, 0, 0, -u * p.x, -u * p.y], u);
    add([0, 0, 0, p.x, p.y, 1, -v * p.x, -v * p.y], v);
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-12) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = m[r]![c]! / m[c]![c]!;
      for (let j = c; j <= n; j++) m[r]![j]! -= k * m[c]![j]!;
    }
  }
  const hn: H = [...m.map((row, i) => row[n]! / row[i]!), 1];
  const tInv = invertH(t.t);
  if (!tInv || !hn.every(Number.isFinite)) return null;
  const h = mul3(mul3(tInv, hn), f.t);
  const s = h[8]!;
  return Math.abs(s) > 1e-14 && h.every(Number.isFinite) ? h.map((v) => v / s) : null;
}
