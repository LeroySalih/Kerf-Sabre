import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { DEFAULT_MATERIAL_ID, PLACEHOLDER_PRESETS, findPreset, formatOperation, presetLabel, resolvePreset } from "../src/presets";

const schema = JSON.parse(readFileSync(new URL("../../shared/preset.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

describe("placeholder presets", () => {
  it("every preset is valid against shared/preset.schema.json", () => {
    for (const p of PLACEHOLDER_PRESETS) {
      expect(validate(p), `${p.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
  it("ids are unique and the default exists", () => {
    const ids = PLACEHOLDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findPreset(DEFAULT_MATERIAL_ID)).toBeDefined();
  });
  it("the shared schema really does reject a bad preset (the test is not vacuous)", () => {
    expect(validate({ ...PLACEHOLDER_PRESETS[0]!, cut: { powerPct: 150, speedMmPerS: 3, passes: 1, airAssist: true } })).toBe(false);
  });
});

describe("resolvePreset", () => {
  const ply = findPreset("ply-3mm")!;
  it("applies a laser's overrides on top of the base", () => {
    const r = resolvePreset(ply, "station-2");
    expect(r.kerfMm).toBe(0.25);
    expect(r.cut.speedMmPerS).toBe(2.5);
    expect(r.cut.powerPct).toBe(100); // untouched fields stay
    expect(r.score).toEqual(ply.score);
  });
  it("uses the base for lasers with no override", () => {
    const r = resolvePreset(ply, "station-1");
    expect(r.kerfMm).toBe(0.2);
    expect(r.cut).toEqual(ply.cut);
  });
  it("flags a laser that has not been tested with this material", () => {
    expect(resolvePreset(ply, "station-1").untested).toBe(false);
    expect(resolvePreset(ply, "station-3").untested).toBe(true);
    expect(resolvePreset({ ...ply, testedOn: undefined }, "station-1").untested).toBe(true);
  });
  it("does not mutate the preset", () => {
    const before = JSON.stringify(ply);
    resolvePreset(ply, "station-2");
    expect(JSON.stringify(ply)).toBe(before);
  });
});

describe("formatting", () => {
  it("labels and describes", () => {
    expect(presetLabel(findPreset("ply-3mm")!)).toBe("Plywood 3 mm");
    expect(formatOperation({ powerPct: 100, speedMmPerS: 3, passes: 2, airAssist: true })).toBe("100% power, 3 mm/s, 2 passes, air on");
    expect(formatOperation({ powerPct: 20, speedMmPerS: 20, passes: 1, airAssist: false })).toBe("20% power, 20 mm/s, 1 pass, air off");
  });
});
