// Text to paths. Outline fonts come from opentype.js (laid out glyph by glyph: its GSUB handling
// throws on some fonts); single-line fonts are Hershey stroke data, meant for Score text.
// Output is design-space (mm, Y-up) paths with the baseline start at the origin.
import { parse, type Font } from "opentype.js";
import hershey from "./fonts/hershey.json";
import type { Point } from "./coords";
import type { Path, Seg } from "./geometry";

export interface TextSpec {
  content: string;
  font: string; // FontEntry id
  /** Font size (em) in mm. Cap height is about 0.73 x this for every font. */
  sizeMm: number;
}

export type FontKind = "outline" | "single";

export interface FontEntry {
  id: string;
  label: string;
  kind: FontKind;
  outline?: Font;
  strokes?: { d: string; o: number }[];
}

const CAP_RATIO = 0.729; // DejaVu cap height / em
const registry = new Map<string, FontEntry>();

export const DEFAULT_FONT = "dejavu-sans";

// Hershey stroke fonts are built in.
for (const [key, f] of Object.entries(hershey as Record<string, { label: string; chars: { d: string; o: number }[] }>))
  registry.set(`hershey-${key}`, { id: `hershey-${key}`, label: f.label, kind: "single", strokes: f.chars });

export function registerOutlineFont(id: string, label: string, buffer: ArrayBuffer): FontEntry {
  const entry: FontEntry = { id, label, kind: "outline", outline: parse(buffer) };
  registry.set(id, entry);
  return entry;
}

export const getFont = (id: string): FontEntry | undefined => registry.get(id);
export const listFonts = (): FontEntry[] => [...registry.values()].sort((a, b) => Number(a.kind === "single") - Number(b.kind === "single") || a.label.localeCompare(b.label));

/** Bundled outline fonts (served from /fonts). `fetchBuffer` is injected so tests can read from disk. */
export const BUNDLED_FONTS: { id: string; label: string; file: string }[] = [
  { id: "dejavu-sans", label: "DejaVu Sans", file: "DejaVuSans.ttf" },
  { id: "dejavu-sans-bold", label: "DejaVu Sans Bold", file: "DejaVuSans-Bold.ttf" },
  { id: "dejavu-serif", label: "DejaVu Serif", file: "DejaVuSerif.ttf" },
  { id: "dejavu-mono", label: "DejaVu Sans Mono", file: "DejaVuSansMono.ttf" },
];

export async function loadBundledFonts(fetchBuffer: (file: string) => Promise<ArrayBuffer>): Promise<void> {
  await Promise.all(BUNDLED_FONTS.map(async (f) => { registerOutlineFont(f.id, f.label, await fetchBuffer(f.file)); }));
}

// ---- layout ----

function outlinePaths(font: Font, content: string, size: number): Path[] {
  const scale = size / font.unitsPerEm;
  const out: Path[] = [];
  let x = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const ch of content.replace(/[\r\n\t]+/g, " ")) {
    const glyph = font.charToGlyph(ch);
    if (prev) { try { x += font.getKerningValue(prev, glyph) * scale; } catch { /* unsupported kerning table: no kerning */ } }
    let cur: { start: Point; segs: Seg[] } | null = null;
    let pen: Point = { x: 0, y: 0 };
    const pt = (px: number | undefined, py: number | undefined): Point => ({ x: px ?? 0, y: -(py ?? 0) }); // opentype is Y-down
    // Glyph contours are always closed; opentype.js may or may not emit a Z, and the last point often repeats the start.
    const finish = () => {
      if (cur && cur.segs.length) {
        const last = cur.segs[cur.segs.length - 1]!;
        if (last.t === "l" && Math.hypot(last.to.x - cur.start.x, last.to.y - cur.start.y) < 1e-9) cur.segs.pop();
        if (cur.segs.length) out.push({ start: cur.start, segs: cur.segs, closed: true });
      }
      cur = null;
    };
    for (const c of glyph.getPath(x, 0, size).commands) {
      if (c.type === "M") { finish(); pen = pt(c.x, c.y); cur = { start: pen, segs: [] }; }
      else if (c.type === "L" && cur) { pen = pt(c.x, c.y); cur.segs.push({ t: "l", to: pen }); }
      else if (c.type === "C" && cur) { const to = pt(c.x, c.y); cur.segs.push({ t: "c", c1: pt(c.x1, c.y1), c2: pt(c.x2, c.y2), to }); pen = to; }
      else if (c.type === "Q" && cur) { // quadratic -> exact cubic
        const q = pt(c.x1, c.y1), to = pt(c.x, c.y);
        cur.segs.push({
          t: "c",
          c1: { x: pen.x + (2 / 3) * (q.x - pen.x), y: pen.y + (2 / 3) * (q.y - pen.y) },
          c2: { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
          to,
        });
        pen = to;
      } else if (c.type === "Z") finish();
    }
    finish();
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return out;
}

const HERSHEY_BASELINE = 22; // y of the baseline in Hershey glyph units (y points down)
const HERSHEY_CAP = 21; // cap-letter height in glyph units
const HERSHEY_SPACE = 14;

function strokePaths(strokes: { d: string; o: number }[], content: string, size: number): Path[] {
  const k = (size * CAP_RATIO) / HERSHEY_CAP;
  const out: Path[] = [];
  let x = 0;
  for (const ch of content.replace(/[\r\n\t]+/g, " ")) {
    const code = ch.charCodeAt(0);
    const g = code > 32 ? strokes[code - 33] : undefined;
    if (!g) { x += HERSHEY_SPACE; continue; }
    for (const sub of g.d.split("M").slice(1)) {
      const nums = sub.replace(/L/g, " ").trim().split(/[\s,]+/).map(Number);
      const pts: Point[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: (x + nums[i]!) * k, y: (HERSHEY_BASELINE - nums[i + 1]!) * k });
      if (pts.length < 2) continue;
      const first = pts[0]!, last = pts[pts.length - 1]!;
      const closed = pts.length > 2 && Math.hypot(first.x - last.x, first.y - last.y) < 1e-9;
      out.push({ start: first, segs: pts.slice(1, closed ? -1 : undefined).map((to): Seg => ({ t: "l", to })), closed });
    }
    x += 2 * g.o;
  }
  return out;
}

/** Contours for the text, or [] if the font is not loaded or the text is empty. */
export function textToPaths(spec: TextSpec): Path[] {
  const entry = registry.get(spec.font);
  if (!entry || !(spec.sizeMm > 0) || !spec.content) return [];
  if (entry.kind === "single") return strokePaths(entry.strokes!, spec.content, spec.sizeMm);
  return outlinePaths(entry.outline!, spec.content, spec.sizeMm);
}
