import { describe, expect, it } from "vitest";
import { applyFilter, countText, groupOptions, matches } from "../src/queuefilter";

const rows = [
  { pupilId: "P001", pupilName: "Zoë Adams", pupilGroups: [{ code: "9B-DT", label: "Y9 set 2" }, { code: "ART" }], name: "Pencil pot", ticket: 12, jobId: "job-aa11" },
  { pupilId: "P002", pupilName: "Ben Cole", pupilGroups: [{ code: "9C-DT" }], name: null, ticket: 13, jobId: "job-bb22" },
  { pupilId: "P003", pupilGroups: [], ticket: 14, jobId: "job-cc33" },
];

describe("queue filter", () => {
  it("finds by name (any case, accents ignored), ID, file name or ticket", () => {
    expect(applyFilter(rows, { text: "zoe", group: "" }).map((r) => r.pupilId)).toEqual(["P001"]);
    expect(applyFilter(rows, { text: "p00", group: "" })).toHaveLength(3);
    expect(applyFilter(rows, { text: "pencil", group: "" }).map((r) => r.pupilId)).toEqual(["P001"]);
    expect(applyFilter(rows, { text: "#13", group: "" }).map((r) => r.pupilId)).toEqual(["P002"]);
    expect(applyFilter(rows, { text: "ben cole", group: "" }).map((r) => r.pupilId)).toEqual(["P002"]);
    expect(applyFilter(rows, { text: "ben adams", group: "" })).toEqual([]);
  });
  it("filters by group, any of the pupil's groups", () => {
    expect(applyFilter(rows, { text: "", group: "ART" }).map((r) => r.pupilId)).toEqual(["P001"]);
    expect(applyFilter(rows, { text: "", group: "9C-DT" }).map((r) => r.pupilId)).toEqual(["P002"]);
    expect(matches(rows[2]!, { text: "", group: "ART" })).toBe(false);
    expect(applyFilter(rows, { text: "", group: "" })).toHaveLength(3);
  });
  it("lists the groups once, sorted, and counts", () => {
    expect(groupOptions(rows).map((g) => g.code)).toEqual(["9B-DT", "9C-DT", "ART"]);
    expect(countText(1, 3, { text: "zoe", group: "" })).toBe("Showing 1 of 3");
    expect(countText(3, 3, { text: "", group: "" })).toBe("");
  });
});
