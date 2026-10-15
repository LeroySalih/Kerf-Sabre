// The bed size the pupil designs on. A pupil does not know which laser will cut their file (a teacher picks that when
// approving it), so the Editor starts with a bed every laser can cut, offers the real laser sizes, and allows a custom size.
import type { BedSize } from "./bounds";

export const MIN_BED_MM = 50;
export const MAX_BED_MM = 2000;

const same = (a: BedSize, b: BedSize): boolean => Math.abs(a.widthMm - b.widthMm) < 0.01 && Math.abs(a.heightMm - b.heightMm) < 0.01;
const round = (n: number): number => Math.round(n * 100) / 100;
export const bedText = (b: BedSize): string => `${round(b.widthMm)} × ${round(b.heightMm)} mm`;

/** The largest rectangle that fits on every laser's bed. */
export function commonBed(beds: BedSize[]): BedSize {
  if (!beds.length) return { widthMm: 400, heightMm: 400 };
  return { widthMm: Math.min(...beds.map((b) => b.widthMm)), heightMm: Math.min(...beds.map((b) => b.heightMm)) };
}

export interface BedChoice { value: string; label: string; bed: BedSize }

/** Dropdown choices: the size every laser can cut first, then each other laser size, smallest first. */
export function bedChoices(beds: BedSize[]): BedChoice[] {
  const common = commonBed(beds);
  const out: BedChoice[] = [{ value: "common", label: beds.length > 1 ? `Fits every laser (${bedText(common)})` : bedText(common), bed: common }];
  const others: BedSize[] = [];
  for (const b of beds) if (!same(b, common) && !others.some((o) => same(o, b))) others.push(b);
  others.sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm);
  others.forEach((b, i) => out.push({ value: `laser-${i}`, label: bedText(b), bed: b }));
  return out;
}

export function validateBed(widthMm: number, heightMm: number): string | null {
  if (![widthMm, heightMm].every((n) => Number.isFinite(n) && n >= MIN_BED_MM && n <= MAX_BED_MM)) return `The bed must be between ${MIN_BED_MM} and ${MAX_BED_MM} mm each way.`;
  return null;
}

/** A remembered size from storage, or null if it is missing or not sensible. */
export function parseBed(text: string | null): BedSize | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { widthMm?: unknown; heightMm?: unknown };
    if (typeof v.widthMm !== "number" || typeof v.heightMm !== "number" || validateBed(v.widthMm, v.heightMm)) return null;
    return { widthMm: v.widthMm, heightMm: v.heightMm };
  } catch { return null; }
}

/** True if the design's extent fits at least one laser's bed. */
export const fitsAnyLaser = <T>(items: T[], beds: BedSize[], outside: (items: T[], bed: BedSize) => number[]): boolean =>
  !beds.length || beds.some((b) => outside(items, b).length === 0);
