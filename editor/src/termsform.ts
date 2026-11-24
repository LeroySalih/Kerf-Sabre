// The Platform's terms form (docs/ACCOUNTS.md "Terms"): Kerf's default terms, or one school's. Pure, so the rules are
// tested (tests/termsform.test.ts); the pages are in admin/pages.ts.
import type { DialogField, DialogValue } from "./dialog";

export type Feature = "laser" | "activities";
export type LimitKey = "groupsPerSchool" | "pupilsPerGroup" | "filesPerPupil" | "laserGroups";
export interface Grant { label: string; months?: number; from?: string | null; until?: string | null; features: Partial<Record<Feature, boolean>>; limits: Partial<Record<LimitKey, number | null>> }
export interface Terms { features: Record<Feature, boolean>; limits: Record<LimitKey, number | null>; grants: Grant[] }

export const FEATURES: [Feature, string][] = [["laser", "Send files to the laser (queue, approval, Station pages, camera)"], ["activities", "Activities and teacher feedback"]];
export const LIMITS: [LimitKey, string][] = [["groupsPerSchool", "Groups per school"], ["pupilsPerGroup", "Pupils per group"], ["filesPerPupil", "Files per pupil"], ["laserGroups", "Groups that send to the laser"]];
/** How many grants the form shows (blank label = no grant). */
export const GRANT_SLOTS = 3;
const ONOFF = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const KEEP = [{ value: "", label: "No change" }, { value: "yes", label: "Yes" }];

const lim = (v: number | null | undefined) => (v == null ? "" : String(v));
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");

/** The form. `isDefault`: grants last N months from registration; otherwise they have dates. */
export function termsFields(t: Terms, isDefault: boolean): DialogField[] {
  const f: DialogField[] = [
    ...FEATURES.map(([k, label]): DialogField => ({ key: `f.${k}`, label, type: "select", value: t.features[k] ? "yes" : "no", options: ONOFF })),
    ...LIMITS.map(([k, label]): DialogField => ({ key: `l.${k}`, label, type: "text", value: lim(t.limits[k]), hint: "Blank: no limit" })),
  ];
  for (let i = 0; i < GRANT_SLOTS; i++) {
    const g = t.grants[i];
    const n = i + 1;
    f.push({ key: `g${i}.label`, label: `Extra ${n}: name`, type: "text", value: g?.label ?? "", hint: n === 1 ? "e.g. \"3 months of everything\". Leave blank for none." : undefined });
    if (isDefault) f.push({ key: `g${i}.months`, label: `Extra ${n}: months from registration`, type: "text", value: g?.months == null ? "" : String(g.months) });
    else {
      f.push({ key: `g${i}.from`, label: `Extra ${n}: from (date)`, type: "text", value: day(g?.from), hint: "YYYY-MM-DD; blank: from now" });
      f.push({ key: `g${i}.until`, label: `Extra ${n}: until (date)`, type: "text", value: day(g?.until), hint: "YYYY-MM-DD; blank: for good" });
    }
    for (const [k, label] of FEATURES) f.push({ key: `g${i}.f.${k}`, label: `Extra ${n}: ${label.split(" (")[0]}`, type: "select", value: g?.features[k] ? "yes" : "", options: KEEP });
    for (const [k, label] of LIMITS) {
      const has = !!g && k in g.limits;
      f.push({ key: `g${i}.l.${k}`, label: `Extra ${n}: ${label}`, type: "text", value: has ? (g!.limits[k] == null ? "none" : String(g!.limits[k])) : "", hint: "Blank: no change; \"none\": no limit" });
    }
  }
  return f;
}

function count(text: string, label: string, noneWord: boolean): number | null {
  const t = text.trim().toLowerCase();
  if (t === "" || (noneWord && t === "none")) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number of 0 or more${noneWord ? ", \"none\" or blank" : ", or blank"}.`);
  return n;
}

function date(text: string, label: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) throw new Error(`${label} is a date like 2027-09-01.`);
  return `${t}T00:00:00Z`;
}

/** The answers as terms. Throws a plain message if something is wrong. */
export function termsFromForm(v: Record<string, DialogValue>, isDefault: boolean): Terms {
  const s = (k: string) => String(v[k] ?? "");
  const out: Terms = {
    features: Object.fromEntries(FEATURES.map(([k]) => [k, s(`f.${k}`) === "yes"])) as Terms["features"],
    limits: Object.fromEntries(LIMITS.map(([k, label]) => [k, count(s(`l.${k}`), label, false)])) as Terms["limits"],
    grants: [],
  };
  for (let i = 0; i < GRANT_SLOTS; i++) {
    const label = s(`g${i}.label`).trim();
    if (!label) continue;
    const g: Grant = { label, features: {}, limits: {} };
    if (isDefault) {
      const m = Number(s(`g${i}.months`).trim());
      if (!Number.isInteger(m) || m < 1 || m > 120) throw new Error(`${label}: months is a whole number from 1 to 120.`);
      g.months = m;
    } else {
      g.from = date(s(`g${i}.from`), `${label}: from`);
      g.until = date(s(`g${i}.until`), `${label}: until`);
      if (g.from && g.until && g.until <= g.from) throw new Error(`${label}: "until" must be after "from".`);
    }
    for (const [k] of FEATURES) if (s(`g${i}.f.${k}`) === "yes") g.features[k] = true;
    for (const [k, l] of LIMITS) {
      const t = s(`g${i}.l.${k}`).trim();
      if (t !== "") g.limits[k] = count(t, `${label}: ${l}`, true);
    }
    out.grants.push(g);
  }
  return out;
}

/** "Laser, activities · 20 groups, 50 pupils per group, 20 files per pupil" for a table cell. */
export function termsText(t: { features: Record<string, boolean>; limits: Record<string, number | null> }): string {
  const feats = FEATURES.filter(([k]) => t.features[k]).map(([k]) => (k === "laser" ? "laser" : "activities"));
  const lims = LIMITS.filter(([k]) => t.limits[k] != null).map(([k, label]) => `${t.limits[k]} ${label.toLowerCase()}`);
  return `${feats.length ? feats.join(", ") : "free tools only"}${lims.length ? " · " + lims.join(", ") : " · no limits"}`;
}
