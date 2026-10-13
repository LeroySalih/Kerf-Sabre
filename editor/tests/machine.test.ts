import { describe, expect, it } from "vitest";
import { loadMachineProfiles } from "../src/machine";

describe("machine profiles", () => {
  it("loads the shared profiles with positive bed sizes", () => {
    const profiles = loadMachineProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      expect(p.bed.widthMm).toBeGreaterThan(0);
      expect(p.bed.heightMm).toBeGreaterThan(0);
    }
  });
});
