// Material presets, shaped like shared/preset.schema.json (schemaVersion 0.2.3).
// PLACEHOLDER VALUES: these stand in until the Server serves real presets. Teachers will edit them there;
// pupils only ever select one and see its settings locked.

export interface Operation {
  powerPct: number;
  speedMmPerS: number;
  passes: number;
  airAssist: boolean;
}

export interface Preset {
  schemaVersion: "0.2.3";
  id: string;
  version: number;
  material: string;
  thicknessMm: number;
  sheet: { widthMm: number; heightMm: number; costSar?: number | null };
  kerfMm: number;
  cut: Operation;
  score: Operation;
  laserOverrides?: Record<string, { kerfMm?: number; cut?: Partial<Operation>; score?: Partial<Operation> }>;
  testedOn?: string[];
  updatedBy?: string;
}

const op = (powerPct: number, speedMmPerS: number, passes: number, airAssist: boolean): Operation => ({ powerPct, speedMmPerS, passes, airAssist });

export const PLACEHOLDER_PRESETS: Preset[] = [
  { schemaVersion: "0.2.3", id: "ply-3mm", version: 2, material: "Plywood", thicknessMm: 3, sheet: { widthMm: 600, heightMm: 400, costSar: 12.5 }, kerfMm: 0.2,
    cut: op(100, 3, 2, true), score: op(20, 20, 1, false), laserOverrides: { "station-2": { kerfMm: 0.25, cut: { speedMmPerS: 2.5 } } }, testedOn: ["station-1"] },
  { schemaVersion: "0.2.3", id: "ply-6mm", version: 1, material: "Plywood", thicknessMm: 6, sheet: { widthMm: 600, heightMm: 400, costSar: 20 }, kerfMm: 0.25,
    cut: op(100, 1.5, 4, true), score: op(25, 20, 1, false), testedOn: [] },
  { schemaVersion: "0.2.3", id: "mdf-3mm", version: 1, material: "MDF", thicknessMm: 3, sheet: { widthMm: 600, heightMm: 400, costSar: 8 }, kerfMm: 0.2,
    cut: op(100, 3.5, 2, true), score: op(18, 20, 1, false), testedOn: [] },
  { schemaVersion: "0.2.3", id: "card-1mm", version: 1, material: "Card", thicknessMm: 1, sheet: { widthMm: 400, heightMm: 300, costSar: 2 }, kerfMm: 0.1,
    cut: op(40, 12, 1, true), score: op(10, 30, 1, false), testedOn: [] },
  { schemaVersion: "0.2.3", id: "acrylic-opaque-3mm", version: 1, material: "Acrylic (opaque dark)", thicknessMm: 3, sheet: { widthMm: 600, heightMm: 400, costSar: 30 }, kerfMm: 0.15,
    cut: op(100, 1.2, 5, true), score: op(30, 15, 1, false), testedOn: [] },
];

export const DEFAULT_MATERIAL_ID = "ply-3mm";

export const presetLabel = (p: Preset): string => `${p.material} ${p.thicknessMm} mm`;
/** The presets in use: the placeholders until the Editor signs in to a server, then the server's list (edited in place). */
export const presetStore: Preset[] = [...PLACEHOLDER_PRESETS];
export function setPresets(list: Preset[]): void {
  if (list.length) presetStore.splice(0, presetStore.length, ...list);
}
export const findPreset = (id: string | undefined, presets: Preset[] = presetStore): Preset | undefined => presets.find((p) => p.id === id);

export interface ResolvedPreset {
  preset: Preset;
  kerfMm: number;
  cut: Operation;
  score: Operation;
  /** No completed test grid for this laser yet: a teacher must run one before pupils cut (brief section 6). */
  untested: boolean;
}

/** Base preset with the per-laser overrides for `machineId` applied. */
export function resolvePreset(preset: Preset, machineId: string): ResolvedPreset {
  const o = preset.laserOverrides?.[machineId];
  return {
    preset,
    kerfMm: o?.kerfMm ?? preset.kerfMm,
    cut: { ...preset.cut, ...o?.cut },
    score: { ...preset.score, ...o?.score },
    untested: !(preset.testedOn ?? []).includes(machineId),
  };
}

export function formatOperation(o: Operation): string {
  return `${o.powerPct}% power, ${o.speedMmPerS} mm/s, ${o.passes} ${o.passes === 1 ? "pass" : "passes"}, air ${o.airAssist ? "on" : "off"}`;
}
