// The Admin site's Materials page forms: what they ask, and how the answers become a material preset (shared/preset.schema.json).
// Pure, so the rules are tested (tests/materialform.test.ts); the page itself is in admin/pages.ts.
import type { DialogField, DialogValue } from "./dialog";
import type { Operation, Preset } from "./presets";

export const SCHEMA_VERSION = "0.2.27";
export const MATERIAL_ID = /^[a-z0-9][a-z0-9-]*$/;
const YESNO = [{ value: "yes", label: "On" }, { value: "no", label: "Off" }];

/** "MDF", 3 -> "mdf-3mm": a suggested id for a new material. */
export function suggestId(material: string, thicknessMm: number): string {
  const base = material.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "material";
  return `${base}-${String(thicknessMm).replace(".", "-")}mm`;
}

const opFields = (prefix: "cut" | "score", label: string, o?: Operation): DialogField[] => [
  { key: `${prefix}Power`, label: `${label}: power (%)`, type: "number", value: o?.powerPct ?? (prefix === "cut" ? 100 : 20), min: 0, max: 100 },
  { key: `${prefix}Speed`, label: `${label}: speed (mm/s)`, type: "number", value: o?.speedMmPerS ?? (prefix === "cut" ? 3 : 20), min: 0.1 },
  { key: `${prefix}Passes`, label: `${label}: passes`, type: "number", value: o?.passes ?? 1, min: 1, integer: true },
  { key: `${prefix}Air`, label: `${label}: air assist`, type: "select", value: (o?.airAssist ?? prefix === "cut") ? "yes" : "no", options: YESNO },
];

/** The add/edit-a-material form. Pass the current preset to edit it; leave it out to add one. */
export function materialFields(cur?: Preset): DialogField[] {
  return [
    { key: "material", label: "Material", type: "text", value: cur?.material ?? "", hint: "e.g. Plywood, MDF, Acrylic (opaque dark)" },
    { key: "thicknessMm", label: "Thickness (mm)", type: "number", value: cur?.thicknessMm ?? 3, min: 0.1 },
    ...(cur ? [] : [{ key: "id", label: "ID (optional)", type: "text" as const, value: "", hint: "Leave blank to make one from the name and thickness, e.g. mdf-3mm. It cannot be changed later." }]),
    { key: "kerfMm", label: "Kerf: width of the cut (mm)", type: "number", value: cur?.kerfMm ?? 0.2, min: 0, hint: "Outlines are moved out by half of this so parts come out the drawn size" },
    ...opFields("cut", "Cut", cur?.cut),
    ...opFields("score", "Score", cur?.score),
    { key: "sheetW", label: "Sheet width (mm)", type: "number", value: cur?.sheet.widthMm ?? 600, min: 1 },
    { key: "sheetH", label: "Sheet height (mm)", type: "number", value: cur?.sheet.heightMm ?? 400, min: 1 },
    { key: "cost", label: "Sheet cost (SAR, optional)", type: "text", value: cur?.sheet.costSar == null ? "" : String(cur.sheet.costSar) },
  ];
}

function num(v: Record<string, DialogValue>, k: string, label: string, min: number, max = Infinity, integer = false): number {
  const n = Number(v[k]);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${label} must be ${integer ? "a whole number " : ""}${max === Infinity ? `at least ${min}` : `from ${min} to ${max}`}.`);
  }
  return n;
}

const opFrom = (v: Record<string, DialogValue>, prefix: "cut" | "score", label: string): Operation => ({
  powerPct: num(v, `${prefix}Power`, `${label} power`, 0, 100),
  speedMmPerS: (() => { const s = num(v, `${prefix}Speed`, `${label} speed`, 0); if (s <= 0) throw new Error(`${label} speed must be more than 0.`); return s; })(),
  passes: num(v, `${prefix}Passes`, `${label} passes`, 1, Infinity, true),
  airAssist: v[`${prefix}Air`] === "yes",
});

/** The answers as a preset, keeping what the form does not ask about (per-laser settings, tested lasers, dotted lines). Throws a plain message if something is wrong. */
export function presetFromForm(v: Record<string, DialogValue>, cur?: Preset): Preset {
  const material = String(v.material ?? "").trim();
  if (!material) throw new Error("Give the material a name.");
  const thicknessMm = num(v, "thicknessMm", "The thickness", 0.01);
  const id = cur?.id ?? (String(v.id ?? "").trim().toLowerCase() || suggestId(material, thicknessMm));
  if (!MATERIAL_ID.test(id)) throw new Error("The ID may only use lower case letters, numbers and dashes, and must start with a letter or number.");
  const costText = String(v.cost ?? "").trim();
  const cost = costText === "" ? null : Number(costText);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error("The sheet cost must be a number of 0 or more, or left blank.");
  const keepDash = (o: Operation, old?: Operation): Operation => ((old as Operation & { dashMm?: number } | undefined)?.dashMm ? { ...o, dashMm: (old as Operation & { dashMm: number }).dashMm } as Operation : o);
  return {
    ...(cur ?? {}),
    schemaVersion: SCHEMA_VERSION as Preset["schemaVersion"],
    id,
    version: cur?.version ?? 1,
    material,
    thicknessMm,
    sheet: { widthMm: num(v, "sheetW", "The sheet width", 1), heightMm: num(v, "sheetH", "The sheet height", 1), costSar: cost },
    kerfMm: num(v, "kerfMm", "The kerf", 0),
    cut: keepDash(opFrom(v, "cut", "Cut"), cur?.cut),
    score: keepDash(opFrom(v, "score", "Score"), cur?.score),
    laserOverrides: cur?.laserOverrides ?? {},
    testedOn: cur?.testedOn ?? [],
  };
}

const OVR: [key: string, part: "cut" | "score" | null, field: keyof Operation | "kerfMm", label: string][] = [
  ["kerf", null, "kerfMm", "Kerf (mm)"],
  ["cutPower", "cut", "powerPct", "Cut: power (%)"], ["cutSpeed", "cut", "speedMmPerS", "Cut: speed (mm/s)"], ["cutPasses", "cut", "passes", "Cut: passes"],
  ["scorePower", "score", "powerPct", "Score: power (%)"], ["scoreSpeed", "score", "speedMmPerS", "Score: speed (mm/s)"], ["scorePasses", "score", "passes", "Score: passes"],
];

/** The settings-on-one-laser form: blank means "the same as the material's usual setting" (shown as the hint). */
export function overrideFields(p: Preset, station: string): DialogField[] {
  const o = p.laserOverrides?.[station] ?? {};
  const fields: DialogField[] = OVR.map(([key, part, field, label]) => {
    const own = part ? (o[part] as Partial<Operation> | undefined)?.[field as keyof Operation] : o.kerfMm;
    const base = part ? p[part][field as keyof Operation] : p.kerfMm;
    return { key, label, type: "text", value: own === undefined ? "" : String(own), hint: `Blank: same as usual (${String(base)})` };
  });
  fields.push({ key: "tested", label: `Test-gridded on ${station}`, type: "select", value: (p.testedOn ?? []).includes(station) ? "yes" : "no", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "Not yet" }] });
  return fields;
}

/** The material with its settings on `station` replaced by the form's (blank fields dropped; no override left means none at all). */
export function presetWithOverride(p: Preset, station: string, v: Record<string, DialogValue>): Preset {
  const ov: { kerfMm?: number; cut?: Partial<Operation>; score?: Partial<Operation> } = {};
  for (const [key, part, field, label] of OVR) {
    const t = String(v[key] ?? "").trim();
    if (t === "") continue;
    const n = Number(t);
    const ok = Number.isFinite(n) && (field === "powerPct" ? n >= 0 && n <= 100 : field === "speedMmPerS" ? n > 0 : field === "passes" ? Number.isInteger(n) && n >= 1 : n >= 0);
    if (!ok) throw new Error(`${label}: ${t} is not allowed${field === "powerPct" ? " (0 to 100)" : field === "passes" ? " (a whole number from 1)" : field === "speedMmPerS" ? " (more than 0)" : ""}.`);
    if (part) ov[part] = { ...(ov[part] ?? {}), [field]: n };
    else ov.kerfMm = n;
  }
  const laserOverrides = { ...(p.laserOverrides ?? {}) };
  if (Object.keys(ov).length) laserOverrides[station] = ov;
  else delete laserOverrides[station];
  const tested = new Set(p.testedOn ?? []);
  if (v.tested === "yes") tested.add(station); else if (v.tested === "no") tested.delete(station);
  return { ...p, laserOverrides, testedOn: [...tested].sort() };
}

/** "100% · 3 mm/s · 2 passes · air" for a table cell. */
export const opText = (o: Operation): string => `${o.powerPct}% · ${o.speedMmPerS} mm/s · ${o.passes} pass${o.passes === 1 ? "" : "es"}${o.airAssist ? " · air" : ""}`;
