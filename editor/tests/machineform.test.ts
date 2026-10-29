import { describe, expect, it } from "vitest";
import { STATION_ID, profileFromForm, stationFields } from "../src/machineform";

const answers = { id: "station-5", name: "Station 5", model: "", widthMm: 400, heightMm: 415, originCorner: "front-left", s30Max: 1000, air: "unknown", camera: "usb-uvc" };

describe("station form", () => {
  it("a new station asks for an ID; an existing one does not", () => {
    expect(stationFields().map((f) => f.key)).toContain("id");
    const cur = profileFromForm(answers);
    expect(stationFields(cur).map((f) => f.key)).not.toContain("id");
  });
  it("makes a profile that fits the schema's shape", () => {
    expect(profileFromForm(answers)).toEqual({
      schemaVersion: "0.2.25", id: "station-5", name: "Station 5", model: null, placeholder: false,
      bed: { widthMm: 400, heightMm: 415, originCorner: "front-left" },
      grbl: { baud: 115200, laserMode: true, s30Max: 1000 }, airAssist: { command: "M8", supported: null }, camera: { type: "usb-uvc" },
    });
  });
  it("editing keeps the fields the form does not show, and cannot change the ID", () => {
    const cur = { ...profileFromForm(answers), grbl: { s30Max: 1000, laserMode: true, homingEnabled: true, accelerationXY: 500, baud: 115200 } };
    const next = profileFromForm({ ...answers, id: "other", name: "Renamed", s30Max: 255, air: "yes", model: "Falcon 2" }, cur);
    expect(next.id).toBe("station-5");
    expect(next.grbl).toEqual({ s30Max: 255, laserMode: true, homingEnabled: true, accelerationXY: 500, baud: 115200 });
    expect(next.airAssist.supported).toBe(true);
    expect(next.model).toBe("Falcon 2");
  });
  it("says what is wrong in plain words", () => {
    expect(() => profileFromForm({ ...answers, id: "Station 5" })).toThrow(/lower case/);
    expect(() => profileFromForm({ ...answers, name: "  " })).toThrow(/name/);
    expect(() => profileFromForm({ ...answers, widthMm: 0 })).toThrow(/bed width/);
    expect(STATION_ID.test("a-1")).toBe(true);
    expect(STATION_ID.test("-a")).toBe(false);
  });
});
