import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { circle, rectangle, translation } from "../src/geometry";
import { buildJob } from "../src/job";
import type { QueueEntry, StationInfo } from "../src/server";
import { formatClock, previewSvg, progressPct, sizeOf, stepState } from "../src/stationlogic";

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({ ticket: 4, jobId: "job-1", status: "approved", position: 1, own: false, next: true, ...over });
const station = (over: Partial<StationInfo> = {}): StationInfo => ({ id: "station-1", online: true, state: "Idle", ...over });

describe("stepState", () => {
  it("walks the pupil through frame, confirm, start", () => {
    expect(stepState(entry(), station(), "station-1", false)).toMatchObject({ canFrame: true, canStart: false, framed: false });
    const framed = entry({ framedOn: "station-1" });
    expect(stepState(framed, station(), "station-1", false)).toMatchObject({ canFrame: true, canStart: false, framed: true });
    expect(stepState(framed, station(), "station-1", true)).toMatchObject({ canFrame: true, canStart: true });
  });
  it("being framed on another laser does not count as framed here", () => {
    expect(stepState(entry({ framedOn: "station-2" }), station(), "station-1", true).canStart).toBe(false);
  });
  it("nothing can be pressed when the Cutter is offline, busy, or already cutting", () => {
    for (const st of [station({ online: false }), station({ state: "Run" }), station({ currentJobId: "job-9" }), undefined]) {
      const s = stepState(entry({ framedOn: "station-1" }), st, "station-1", true);
      expect(s.canStart, JSON.stringify(st)).toBe(false);
      expect(s.canFrame, JSON.stringify(st)).toBe(false);
    }
  });
  it("says so when the queue is empty", () => {
    expect(stepState(undefined, station(), "station-1", false).say).toMatch(/nothing/i);
  });
});

describe("progress", () => {
  it("percent and clock", () => {
    expect(progressPct({ jobId: "j", line: 25, totalLines: 100 })).toBe(25);
    expect(progressPct({ jobId: "j", line: 500, totalLines: 100 })).toBe(100);
    expect(progressPct(null)).toBe(0);
    expect(formatClock(75)).toBe("1:15");
    expect(formatClock(5)).toBe("0:05");
  });
});

describe("outline preview", () => {
  const job = () => {
    const d = new Doc();
    d.add(rectangle(60, 40), translation(10, 10), "cut");
    d.add(circle(5), translation(30, 30), "score");
    return buildJob({ objects: d.state.objects, pupilId: "P1", presetId: "x", origin: { mode: "absolute" }, submit: false }).objects;
  };
  it("draws every shape in its layer colour and reports the size", () => {
    const svg = previewSvg(job());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("#dc2626");
    expect(svg).toContain("#2563eb");
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
    expect(svg).toContain("60 by 40 millimetres");
    const s = sizeOf(job())!;
    expect(s.w).toBeCloseTo(60);
    expect(s.h).toBeCloseTo(40);
  });
  it("is empty for no shapes and contains only numbers and fixed markup", () => {
    expect(previewSvg([])).toBe("");
    expect(previewSvg(job())).not.toMatch(/<script|onerror/i);
  });
});

import { sizeText } from "../src/stationlogic";
describe("sizeText", () => {
  it("shows the design's size in mm", () => {
    expect(sizeText({ widthMm: 120, heightMm: 85.04 })).toBe("120 × 85 mm");
    expect(sizeText({ widthMm: 99.96, heightMm: 12.3 })).toBe("100 × 12.3 mm");
  });
  it("is empty when the server has not measured it", () => {
    expect(sizeText(null)).toBe("");
    expect(sizeText(undefined)).toBe("");
    expect(sizeText({ widthMm: NaN, heightMm: 5 })).toBe("");
  });
});
