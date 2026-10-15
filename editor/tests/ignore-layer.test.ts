import { describe, expect, it } from "vitest";
import { canSubmit, outOfBounds } from "../src/bounds";
import { parseClip, serializeClip } from "../src/clipboard";
import { Doc } from "../src/doc";
import { layerFor } from "../src/dxf-import";
import { toDXF, toSVG } from "../src/export";
import { rectangle, translation } from "../src/geometry";
import { buildJob, fromJobObjects } from "../src/job";
import { previewSvg, sizeOf } from "../src/stationlogic";

const bed = { widthMm: 100, heightMm: 100 };

function sample(): Doc {
  const d = new Doc();
  d.add(rectangle(20, 20), translation(10, 10), "cut");
  d.add(rectangle(500, 500), translation(-50, -50), "ignore"); // a big guide, far off the bed
  return d;
}

describe("the ignore layer", () => {
  it("does not have to be on the bed, and does not block sending", () => {
    const d = sample();
    expect(outOfBounds(d.state.objects, bed)).toEqual([]);
    expect(canSubmit(d.state.objects, bed)).toBe(true);
  });

  it("is not enough to send on its own", () => {
    const d = new Doc();
    d.add(rectangle(10, 10), translation(5, 5), "ignore");
    expect(canSubmit(d.state.objects, bed)).toBe(false);
  });

  it("is left out of DXF and SVG exports", () => {
    const d = sample();
    expect(toDXF(d.state.objects)).not.toContain("IGNORE");
    expect(toSVG(d.state.objects)).not.toContain("ignore");
    expect(toSVG(d.state.objects)).toContain('data-layer="cut"');
    expect(toSVG(d.state.objects)).toContain(`width="30mm"`); // 10 + 20: sized by the cut shape alone (the guide reaches 450)
  });

  it("is saved with the job and comes back", () => {
    const d = sample();
    const job = buildJob({ objects: d.state.objects, dimensions: [], pupilId: "P001", presetId: "ply-3mm", origin: { mode: "absolute" }, submit: false });
    expect(job.objects.map((o) => o.layer)).toEqual(["cut", "ignore"]);
    expect(fromJobObjects(job.objects).map((s) => s.layer)).toEqual(["cut", "ignore"]);
  });

  it("is not part of a job's preview or size at the station", () => {
    const d = sample();
    const job = buildJob({ objects: d.state.objects, dimensions: [], pupilId: "P001", presetId: "ply-3mm", origin: { mode: "absolute" }, submit: false });
    expect(sizeOf(job.objects)).toEqual({ w: 20, h: 20 });
    expect(previewSvg(job.objects)).toContain("20 by 20 millimetres");
  });

  it("survives copy and paste, and is found by DXF layer name", () => {
    const d = sample();
    expect(parseClip(serializeClip(d.copyOut(new Set(d.state.objects.map((o) => o.id)))))?.objects.map((o) => o.layer)).toEqual(["cut", "ignore"]);
    expect(layerFor("Ignore", null)).toBe("ignore");
    expect(layerFor("guides_IGNORE", 1)).toBe("ignore");
    expect(layerFor("0", null)).toBe("cut");
  });
});
