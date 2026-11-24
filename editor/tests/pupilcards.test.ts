import { describe, expect, it } from "vitest";
import { cardsHtml, parsePupilLines } from "../src/pupilcards";

describe("pasted pupil lists", () => {
  it("reads IDs, IDs with names, names alone and spreadsheet rows", () => {
    const r = parsePupilLines("P10234\nP10235, Zoë Adams\n, Ben\nSam Lee\n20417\tPriya Patel\n\n  \nbad id!, X");
    expect(r.pupils).toEqual([{ id: "P10234" }, { id: "P10235", name: "Zoë Adams" }, { name: "Ben" }, { name: "Sam Lee" }, { id: "20417", name: "Priya Patel" }]);
    expect(r.bad).toEqual(["bad id!, X"]);
  });
});

describe("Pupil Cards", () => {
  it("has what a pupil types, escaped", () => {
    const html = cardsHtml({ schoolName: "Westfield <High>", schoolCode: "K7RPX", groupCode: "9B-DT", groupLabel: "Year 9", signInUrl: "https://kerf.example/sign-in",
      cards: [{ pupilId: "20417", password: "tiger-river", displayName: "Zoë \"Z\" Adams" }, { pupilId: "20418", password: "maple-otter" }] });
    expect(html).toContain("Westfield &lt;High&gt;");
    expect(html).toContain("Zoë &quot;Z&quot; Adams");
    expect(html).toContain("Pupil 20418");
    for (const s of ["K7RPX", "9B-DT", "20417", "tiger-river", "maple-otter", "https://kerf.example/sign-in", "2 Pupil Cards"]) expect(html).toContain(s);
    expect(html).not.toContain("<High>");
  });
});
