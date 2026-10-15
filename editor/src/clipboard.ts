// Clipboard text <-> shapes. Anything can be pasted into the page, so parsing is strict.
import type { ClipData } from "./doc";
import type { TextSpec } from "./text";

const MAX_OBJECTS = 5000;
const MAX_SEGS = 200_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPt = (v: unknown): boolean => !!v && typeof v === "object" && isNum((v as { x: unknown }).x) && isNum((v as { y: unknown }).y);

function validSeg(s: unknown): boolean {
  if (!s || typeof s !== "object") return false;
  const g = s as Record<string, unknown>;
  if (g.t === "l") return isPt(g.to);
  if (g.t === "a") return isPt(g.c) && isPt(g.to) && typeof g.ccw === "boolean";
  if (g.t === "c") return isPt(g.c1) && isPt(g.c2) && isPt(g.to);
  return false;
}

export function serializeClip(data: ClipData): string {
  return JSON.stringify(data);
}

/** Parse clipboard text. Returns null unless it is a well-formed Kerf Sabre clip. */
export function parseClip(text: string | null | undefined): ClipData | null {
  if (!text || text[0] !== "{") return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.kerfSabre !== 1 || !Array.isArray(d.objects) || d.objects.length === 0 || d.objects.length > MAX_OBJECTS) return null;
  const texts: Record<number, TextSpec> = {};
  if (d.texts && typeof d.texts === "object") {
    for (const [k, v] of Object.entries(d.texts as Record<string, unknown>)) {
      const t = v as Partial<TextSpec> | null;
      if (!t || typeof t.content !== "string" || typeof t.font !== "string" || !isNum(t.sizeMm) || t.sizeMm <= 0 || t.content.length > 1000) return null;
      texts[Number(k)] = { content: t.content, font: t.font, sizeMm: t.sizeMm };
    }
  }
  let segs = 0;
  const objects: ClipData["objects"] = [];
  for (const o of d.objects) {
    if (!o || typeof o !== "object") return null;
    const c = o as Record<string, unknown>;
    const path = c.path as { start?: unknown; segs?: unknown; closed?: unknown } | undefined;
    if (!path || !isPt(path.start) || !Array.isArray(path.segs) || typeof path.closed !== "boolean") return null;
    segs += path.segs.length;
    if (segs > MAX_SEGS || !path.segs.every(validSeg)) return null;
    if (!Array.isArray(c.matrix) || c.matrix.length !== 6 || !c.matrix.every(isNum)) return null;
    if (c.layer !== "score" && c.layer !== "cut" && c.layer !== "ignore") return null;
    if (c.group !== undefined && !isNum(c.group)) return null;
    if (c.textId !== undefined && (!isNum(c.textId) || !texts[c.textId])) return null;
    const st = c.settings as { powerPct?: unknown; speedMmPerS?: unknown } | undefined;
    if (st !== undefined && !(st && isNum(st.powerPct) && isNum(st.speedMmPerS) && st.powerPct >= 0 && st.powerPct <= 100 && st.speedMmPerS > 0)) return null;
    const tb = c.tabs as { widthMm?: unknown; at?: unknown } | undefined;
    if (tb !== undefined && !(tb && isNum(tb.widthMm) && tb.widthMm > 0 && Array.isArray(tb.at) && tb.at.length <= 500 && tb.at.every((f) => isNum(f) && f >= 0 && f <= 1))) return null;
    objects.push({ path: path as ClipData["objects"][number]["path"], matrix: c.matrix as ClipData["objects"][number]["matrix"], layer: c.layer, group: c.group as number | undefined, textId: c.textId as number | undefined, settings: st ? { powerPct: st.powerPct as number, speedMmPerS: st.speedMmPerS as number } : undefined, tabs: tb ? { widthMm: tb.widthMm as number, at: [...(tb.at as number[])] } : undefined });
  }
  return { kerfSabre: 1, objects, texts };
}
