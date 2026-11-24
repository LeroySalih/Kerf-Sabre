import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import type { DialogValue } from "../src/dialog";
import { materialFields, overrideFields, presetFromForm, presetWithOverride, suggestId } from "../src/materialform";
import { PLACEHOLDER_PRESETS } from "../src/presets";

const schema = JSON.parse(readFileSync(new URL("../../shared/preset.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);
const values = (fields: { key: string; value: DialogValue }[]) => Object.fromEntries(fields.map((f) => [f.key, f.value]));
const ply = PLACEHOLDER_PRESETS[0]!;

describe("material form", () => {
  it("a new material from the defaults is a valid preset with a made-up id", () => {
    const v = { ...values(materialFields()), material: "MDF", thicknessMm: 6 };
    const p = presetFromForm(v);
    expect(p.id).toBe("mdf-6mm");
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });

  it("editing keeps the id, the per-laser settings and the tested lasers", () => {
    const v = { ...values(materialFields(ply)), cutPower: 90, cutSpeed: 4 };
    const p = presetFromForm(v, ply);
    expect(p.id).toBe(ply.id);
    expect(p.cut.powerPct).toBe(90);
    expect(p.cut.speedMmPerS).toBe(4);
    expect(p.laserOverrides).toEqual(ply.laserOverrides);
    expect(p.testedOn).toEqual(ply.testedOn);
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses impossible values with a plain message", () => {
    const v = values(materialFields(ply));
    expect(() => presetFromForm({ ...v, cutPower: 150 }, ply)).toThrow(/Cut power/);
    expect(() => presetFromForm({ ...v, cutPasses: 1.5 }, ply)).toThrow(/whole number/);
    expect(() => presetFromForm({ ...v, material: " " }, ply)).toThrow(/name/);
    expect(() => presetFromForm({ ...v, cost: "lots" }, ply)).toThrow(/cost/);
  });

  it("suggests readable ids", () => {
    expect(suggestId("Acrylic (opaque dark)", 3)).toBe("acrylic-opaque-dark-3mm");
    expect(suggestId("Card", 1.5)).toBe("card-1-5mm");
  });
});

describe("settings on one laser", () => {
  it("blank means the usual setting; only what is filled in is kept", () => {
    const v = { ...values(overrideFields(ply, "station-3")), cutSpeed: "2.5", tested: "yes" };
    const p = presetWithOverride(ply, "station-3", v);
    expect(p.laserOverrides?.["station-3"]).toEqual({ cut: { speedMmPerS: 2.5 } });
    expect(p.testedOn).toContain("station-3");
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });

  it("emptying every field removes the laser's own settings", () => {
    const v = { ...values(overrideFields(ply, "station-2")), kerf: "", cutSpeed: "" };
    const p = presetWithOverride(ply, "station-2", v);
    expect(p.laserOverrides?.["station-2"]).toBeUndefined();
  });

  it("shows the laser's current values and refuses bad ones", () => {
    const f = values(overrideFields(ply, "station-2"));
    expect(f.kerf).toBe("0.25");
    expect(f.cutSpeed).toBe("2.5");
    expect(() => presetWithOverride(ply, "station-2", { ...f, cutPower: "101" })).toThrow(/0 to 100/);
  });
});

describe("the material dialog with laser tabs", () => {
  it("builds one preset from the Generic tab and each laser's tab, keeping laser air assist", async () => {
    const { materialDraft, presetFromDraft } = await import("../src/materialform");
    const d = materialDraft(undefined, ["station-1", "station-2"]);
    d.generic = { ...d.generic, material: "MDF", thicknessMm: 3, cutSpeed: 10 };
    d.lasers["station-1"] = { ...d.lasers["station-1"]!, cutPower: "85", cutAir: "no", tested: "yes" };
    const p = presetFromDraft(d);
    expect(p.id).toBe("mdf-3mm");
    expect(p.cut.speedMmPerS).toBe(10);
    expect(p.laserOverrides).toEqual({ "station-1": { cut: { powerPct: 85, airAssist: false } } });
    expect(p.testedOn).toEqual(["station-1"]);
  });

  it("names the laser when its tab has a mistake", async () => {
    const { materialDraft, presetFromDraft } = await import("../src/materialform");
    const d = materialDraft(undefined, ["station-2"]);
    d.generic = { ...d.generic, material: "MDF" };
    d.lasers["station-2"] = { ...d.lasers["station-2"]!, scorePower: "120" };
    expect(() => presetFromDraft(d)).toThrow(/^station-2: Score: power/);
  });

  it("an existing laser setting shows on its tab and blanks clear it", async () => {
    const { materialDraft, presetFromDraft } = await import("../src/materialform");
    const cur = { ...presetFromDraft({ generic: { ...materialDraft(undefined, []).generic, material: "Ply" }, lasers: {} }), laserOverrides: { "station-3": { kerfMm: 0.3, score: { airAssist: true } } } };
    const d = materialDraft(cur, ["station-3"]);
    expect(d.lasers["station-3"]).toMatchObject({ kerf: "0.3", scoreAir: "yes", cutPower: "" });
    d.lasers["station-3"] = { ...d.lasers["station-3"]!, kerf: "", scoreAir: "" };
    expect(presetFromDraft(d, cur).laserOverrides).toEqual({});
  });
});
