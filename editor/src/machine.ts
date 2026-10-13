// Machine facts come from shared/machine-profiles, never hard-coded.

export interface MachineProfile {
  schemaVersion: string;
  id: string;
  name: string;
  model: string | null;
  placeholder: boolean;
  bed: { widthMm: number; heightMm: number; originCorner: "front-left" | "front-right" | "back-left" | "back-right" };
  grbl: { s30Max: number | null; laserMode: boolean | null; [k: string]: unknown };
  airAssist: { supported: boolean | null; command: "M8" | "M7" | "none" };
  camera: { type: "usb-uvc" | "network" | "none" | "unknown" };
}

const modules = import.meta.glob<MachineProfile>("../../shared/machine-profiles/*.json", {
  eager: true,
  import: "default",
});

export function loadMachineProfiles(): MachineProfile[] {
  return Object.values(modules).sort((a, b) => a.id.localeCompare(b.id));
}
