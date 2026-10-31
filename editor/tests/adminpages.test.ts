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
