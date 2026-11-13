// DXF files often arrive in the wrong units (mm read as cm, or cm read as mm), which shows up as a model that is far too big or far too small.
// After a file is read, a model whose longest side is under 10 mm or over 40 cm (400 mm) is flagged and the pupil is offered the two usual fixes:
// "mm -> cm" (divide by 10) and "cm -> mm" (multiply by 10), each with the size the model would then have.
import type { Bounds } from "./geometry";

export const TOO_SMALL_MM = 10;
export const TOO_BIG_MM = 400;

export interface Size { w: number; h: number }
export type SizeIssue = "small" | "large" | null;

export function sizeOfBounds(bs: Bounds[]): Size | null {
  if (!bs.length) return null;
  return { w: Math.max(...bs.map((b) => b.maxX)) - Math.min(...bs.map((b) => b.minX)), h: Math.max(...bs.map((b) => b.maxY)) - Math.min(...bs.map((b) => b.minY)) };
}

/** Is the model's longest side under 10 mm ("small") or over 400 mm ("large")? */
export function sizeIssue(s: Size): SizeIssue {
  const longest = Math.max(s.w, s.h);
  return longest < TOO_SMALL_MM ? "small" : longest > TOO_BIG_MM ? "large" : null;
}

const round = (n: number): number => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
export const sizeLabel = (s: Size): string => `${round(s.w)} × ${round(s.h)} mm`;

export type ScaleChoiceId = "keep" | "mm-to-cm" | "cm-to-mm";
export interface ScaleChoice { id: ScaleChoiceId; factor: number; size: Size; label: string; fixes: boolean }

/**
 * The three things the pupil can do, each with the size the model would have. `fixes` marks a choice that brings the longest side into the
 * 10 mm to 400 mm range; the one that does is recommended.
 */
export function scaleChoices(s: Size): ScaleChoice[] {
  const make = (id: ScaleChoiceId, factor: number, text: string): ScaleChoice => {
    const size = { w: s.w * factor, h: s.h * factor };
    return { id, factor, size, label: `${text} (${sizeLabel(size)})`, fixes: sizeIssue(size) === null };
  };
  return [
    make("keep", 1, "Keep it as it is"),
    make("mm-to-cm", 0.1, "mm → cm: make it 10 times smaller"),
    make("cm-to-mm", 10, "cm → mm: make it 10 times bigger"),
  ];
}

/** Which choice to preselect: the fix in the direction the problem points (too big: shrink; too small: enlarge), if it works; otherwise keep. */
export function suggestedChoice(s: Size): ScaleChoiceId {
  const issue = sizeIssue(s);
  if (!issue) return "keep";
  const want: ScaleChoiceId = issue === "large" ? "mm-to-cm" : "cm-to-mm";
  return scaleChoices(s).find((c) => c.id === want)!.fixes ? want : "keep";
}

/** The explanation shown above the choices. */
export function explainIssue(s: Size, how: { unitsInFile: string | null }): string {
  const issue = sizeIssue(s)!;
  const what = issue === "large" ? "bigger than 40 cm (400 mm), more than the laser can cut" : "smaller than 10 mm, which is tiny";
  const units = how.unitsInFile ? `The file says its units are ${how.unitsInFile}.` : "The file does not say what units it uses, so it was read as centimetres (the Onshape default).";
  return `⚠ This model is ${sizeLabel(s)}: ${what}. DXF files are often mixed up between mm and cm. ${units} Would you like to rescale it?`;
}

/** What a DXF $INSUNITS code means, for the explanation; null when the file gives none. */
export function unitsName(insunits: number | null): string | null {
  const names: Record<number, string> = { 1: "inches", 2: "feet", 4: "millimetres", 5: "centimetres", 6: "metres", 8: "microinches", 9: "mils", 10: "yards" };
  return insunits !== null && insunits in names ? names[insunits]! : null;
}
