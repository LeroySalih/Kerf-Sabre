import { describe, expect, it } from "vitest";
import { termsFields, termsFromForm, termsText, type Terms } from "../src/termsform";

const BASE: Terms = { features: { laser: false, activities: false }, limits: { groupsPerSchool: 20, pupilsPerGroup: 50, filesPerPupil: 20, laserGroups: null }, grants: [] };
const answers = (t: Terms, isDefault: boolean) => Object.fromEntries(termsFields(t, isDefault).map((f) => [f.key, f.value]));

describe("terms form", () => {
  it("round-trips the default terms with a grant", () => {
    const t: Terms = { ...BASE, grants: [{ label: "Laser for 10 groups, 12 months", months: 12, features: { laser: true }, limits: { laserGroups: 10, groupsPerSchool: null } }] };
    expect(termsFromForm(answers(t, true), true)).toEqual(t);
  });

  it("a school's grants have dates", () => {
    const v = { ...answers(BASE, false), "g0.label": "Trial", "g0.until": "2027-03-01", "g0.f.activities": "yes" };
    expect(termsFromForm(v, false).grants).toEqual([{ label: "Trial", from: null, until: "2027-03-01T00:00:00Z", features: { activities: true }, limits: {} }]);
  });

  it("says what is wrong", () => {
    expect(() => termsFromForm({ ...answers(BASE, true), "l.groupsPerSchool": "lots" }, true)).toThrow(/Groups per school/);
    expect(() => termsFromForm({ ...answers(BASE, true), "g0.label": "Trial", "g0.months": "0" }, true)).toThrow(/months/);
    expect(() => termsFromForm({ ...answers(BASE, false), "g0.label": "T", "g0.from": "2027-05-01", "g0.until": "2027-01-01" }, false)).toThrow(/after/);
  });

  it("describes terms in a line", () => {
    expect(termsText(BASE)).toBe("free tools only · 20 groups per school, 50 pupils per group, 20 files per pupil");
    expect(termsText({ features: { laser: true, activities: true }, limits: { groupsPerSchool: null } })).toBe("laser, activities · no limits");
  });
});
