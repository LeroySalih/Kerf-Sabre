// The Admin site's add/edit-a-station form: what it asks, and how its answers become a machine profile (shared/machine-profile.schema.json).
import type { MachineProfile } from "./machine";
import type { DialogField, DialogValue } from "./dialog";

export const SCHEMA_VERSION = "0.2.19";
export const STATION_ID = /^[a-z0-9][a-z0-9-]*$/;
const ORIGINS = [["front-left", "Front left"], ["front-right", "Front right"], ["back-left", "Back left"], ["back-right", "Back right"]] as const;
const CAMERAS = [["usb-uvc", "USB camera"], ["network", "Network camera"], ["none", "No camera"], ["unknown", "Not sure"]] as const;
const AIR = [["unknown", "Not checked yet"], ["yes", "Yes (M8 / M9)"], ["no", "No"]] as const;

/** What the form shows. Pass the laser's current profile to edit it; leave it out to add a new one. */
export function stationFields(cur?: Partial<MachineProfile>): DialogField[] {
  const opts = (rows: readonly (readonly [string, string])[]) => rows.map(([value, label]) => ({ value, label }));
  const air = cur?.airAssist?.supported;
  return [
    ...(cur?.id ? [] : [{ key: "id", label: "ID (lower case letters, numbers and dashes)", type: "text" as const, value: "", hint: "For example station-5. It cannot be changed later." }]),
    { key: "name", label: "Name", type: "text", value: cur?.name ?? "" },
    { key: "model", label: "Laser model (optional)", type: "text", value: cur?.model ?? "" },
    { key: "widthMm", label: "Bed width (mm)", type: "number", value: cur?.bed?.widthMm ?? 400, min: 1 },
    { key: "heightMm", label: "Bed height (mm)", type: "number", value: cur?.bed?.heightMm ?? 400, min: 1 },
    { key: "originCorner", label: "Where the machine's 0,0 is", type: "select", value: cur?.bed?.originCorner ?? "front-left", options: opts(ORIGINS) },
    { key: "s30Max", label: "Maximum power value ($30)", type: "number", value: cur?.grbl?.s30Max ?? 1000, min: 1, hint: "The Cutter reads the real value from the laser; this is what the Server checks against." },
    { key: "air", label: "Air assist works", type: "select", value: air === true ? "yes" : air === false ? "no" : "unknown", options: opts(AIR) },
    { key: "camera", label: "Camera", type: "select", value: cur?.camera?.type ?? "unknown", options: opts(CAMERAS) },
  ];
}

/** Turn the form's answers into a profile, keeping every field of `cur` that the form does not ask about. Throws a plain message if something is wrong. */
export function profileFromForm(v: Record<string, DialogValue>, cur?: Record<string, unknown>): MachineProfile {
  const id = String(cur?.id ?? v.id ?? "").trim();
  if (!STATION_ID.test(id)) throw new Error("The ID may only use lower case letters, numbers and dashes, and must start with a letter or number.");
  const name = String(v.name ?? "").trim();
  if (!name) throw new Error("Give the station a name.");
  const num = (k: string, label: string) => {
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be more than 0.`);
    return n;
  };
  const old = (cur ?? {}) as Partial<MachineProfile>;
  const model = String(v.model ?? "").trim();
  const air = v.air === "yes" ? true : v.air === "no" ? false : null;
  return {
    ...(old as MachineProfile),
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    model: model || null,
    placeholder: false,
    bed: { widthMm: num("widthMm", "The bed width"), heightMm: num("heightMm", "The bed height"), originCorner: String(v.originCorner) as MachineProfile["bed"]["originCorner"] },
    grbl: { baud: 115200, laserMode: true, ...(old.grbl ?? {}), s30Max: num("s30Max", "The maximum power value") },
    airAssist: { command: old.airAssist?.command ?? "M8", supported: air },
    camera: { type: String(v.camera) as MachineProfile["camera"]["type"] },
  };
}
