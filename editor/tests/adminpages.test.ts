import { describe, expect, it } from "vitest";
import { pagesFor } from "../src/admin/pages";

describe("which Admin pages a role sees", () => {
  it("a technician sees only the station pages, nothing else of the admin site", () => {
    expect(pagesFor("technician").map((p) => p.key)).toEqual(["stationpages"]);
  });
  it("an admin has the station pages too; a teacher does not", () => {
    expect(pagesFor("admin").map((p) => p.key)).toContain("stationpages");
    expect(pagesFor("teacher").map((p) => p.key)).not.toContain("stationpages");
    expect(pagesFor("teacher").map((p) => p.key)).not.toContain("staff");
    expect(pagesFor("teacher").map((p) => p.key)).toContain("materials");
    expect(pagesFor("technician").map((p) => p.key)).not.toContain("materials");
  });
});

describe("free and paid schools", () => {
  it("a free school's admin site has the free tools only", () => {
    const keys = pagesFor("admin", "free").map((p) => p.key);
    expect(keys).toEqual(["classes", "pupils", "materials", "school", "staff"]);
    for (const paid of ["queue", "stations", "stationpages", "activities", "overview"]) expect(keys).not.toContain(paid);
    expect(pagesFor("technician", "free")).toEqual([]);
  });
  it("a paid school (or one from before plans) keeps every page", () => {
    expect(pagesFor("admin", "paid").map((p) => p.key)).toContain("queue");
    expect(pagesFor("admin").map((p) => p.key)).toContain("stations");
  });
});

describe("terms: features decide the pages", () => {
  it("free terms with the laser but no activities", () => {
    const keys = pagesFor("admin", { laser: true, activities: false }).map((p) => p.key);
    expect(keys).toContain("queue");
    expect(keys).toContain("stationpages");
    expect(keys).not.toContain("activities");
    expect(pagesFor("technician", { laser: true, activities: false }).map((p) => p.key)).toEqual(["stationpages"]);
  });
  it("activities without the laser", () => {
    const keys = pagesFor("teacher", { laser: false, activities: true }).map((p) => p.key);
    expect(keys).toEqual(["classes", "pupils", "activities", "materials"]);
  });
  it("the Platform has schools and the default terms", () => {
    expect(pagesFor("platform").map((p) => p.key)).toEqual(["schools", "terms"]);
  });
});
