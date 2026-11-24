import { describe, expect, it } from "vitest";
import { checkSchoolName, SCHOOL_NAME_MAX } from "../src/admin/schoolname";
import { renameSchool } from "../src/server";

describe("renaming the school (shared 0.2.45)", () => {
  it("trims the name and keeps ordinary spaces and accents", () => {
    expect(checkSchoolName("  Westfield High  ")).toEqual({ name: "Westfield High" });
    expect(checkSchoolName("École Saint-Exupéry")).toEqual({ name: "École Saint-Exupéry" });
  });

  it("refuses an empty name, control characters and a name that is too long", () => {
    expect(checkSchoolName("   ")).toEqual({ error: "Give the school a name." });
    expect("error" in checkSchoolName("Line\nbreak")).toBe(true);
    expect("error" in checkSchoolName("Tab\there")).toBe(true);
    expect("error" in checkSchoolName("No break")).toBe(true);
    expect(checkSchoolName("a".repeat(SCHOOL_NAME_MAX))).toEqual({ name: "a".repeat(SCHOOL_NAME_MAX) });
    expect(checkSchoolName("a".repeat(SCHOOL_NAME_MAX + 1))).toEqual({ error: "The school's name can be up to 128 characters." });
  });

  it("sends PATCH /school with the name only", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id: "westfield-high", name: "Westfield High", code: "ABCDE" }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await renameSchool({ baseUrl: "https://k", token: "t", role: "admin", id: "a1" }, "Westfield High", f);
    expect(r.name).toBe("Westfield High");
    expect(seen!.url).toBe("https://k/api/v1/school");
    expect(seen!.init.method).toBe("PATCH");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ name: "Westfield High" });
  });
});
