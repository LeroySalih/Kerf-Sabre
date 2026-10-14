import { describe, expect, it } from "vitest";
import { applyMatrix, bedCorners, boundsOf, centreOf, degrees, fitError, fitsBed, makeCalibration, placementMatrix, targetsFromSquares, toBed, toCam } from "../src/alignlogic";
import { applyH, invertH, solveHomography, solveHomographyLS } from "../src/homography";

// The pretend camera's picture: a 400 x 400 mm bed seen at these pixels (see devtools/fake_cutter.py).
const CAM = [{ x: 110, y: 430 }, { x: 540, y: 425 }, { x: 500, y: 40 }, { x: 150, y: 45 }];

describe("homography", () => {
  it("maps the four points exactly onto their targets", () => {
    const h = solveHomography(CAM, bedCorners(400, 400))!;
    bedCorners(400, 400).forEach((b, i) => {
      const p = applyH(h, CAM[i]!);
      expect(p.x).toBeCloseTo(b.x, 6);
      expect(p.y).toBeCloseTo(b.y, 6);
    });
  });
  it("inverts, and the inverse round-trips an interior point", () => {
    const h = solveHomography(CAM, bedCorners(400, 400))!;
    const inv = invertH(h)!;
    const bed = applyH(h, { x: 320, y: 240 });
    const back = applyH(inv, bed);
    expect(back.x).toBeCloseTo(320, 6);
    expect(back.y).toBeCloseTo(240, 6);
    expect(bed.x).toBeGreaterThan(0); expect(bed.x).toBeLessThan(400);
  });
  it("refuses three points in a line", () => {
    expect(solveHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 5, y: 0 }], bedCorners(10, 10))).toBeNull();
  });
});

describe("calibration from four clicks", () => {
  it("accepts the corners in order and keeps the bed points with them", () => {
    const c = makeCalibration(CAM, bedCorners(400, 400), 640, 480)!;
    expect(c.points.map((p) => p.bed)).toEqual([[0, 0], [400, 0], [400, 400], [0, 400]]);
    expect(toBed(c, CAM[2]!).x).toBeCloseTo(400, 6);
    const cam = toCam(c)({ x: 400, y: 0 });
    expect(cam.x).toBeCloseTo(540, 5);
    expect(cam.y).toBeCloseTo(425, 5);
  });
  it("rejects clicks that go round the wrong way or cross over", () => {
    expect(makeCalibration([...CAM].reverse(), bedCorners(400, 400), 640, 480)).toBeNull();
    expect(makeCalibration([CAM[0]!, CAM[2]!, CAM[1]!, CAM[3]!], bedCorners(400, 400), 640, 480)).toBeNull();
    expect(makeCalibration(CAM.slice(0, 3), bedCorners(400, 400).slice(0, 3), 640, 480)).toBeNull();
  });
});

describe("placement", () => {
  const square = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 10, y: 30 }];
  const c = centreOf(square);
  it("the identity leaves the design where it is", () => {
    const m = placementMatrix(0, c, 0, 0);
    square.forEach((p) => { const q = applyMatrix(m, p); expect(q.x).toBeCloseTo(p.x); expect(q.y).toBeCloseTo(p.y); });
  });
  it("a move shifts everything", () => {
    const q = applyMatrix(placementMatrix(0, c, 100, -5), { x: 10, y: 10 });
    expect(q).toEqual({ x: 110, y: 5 });
  });
  it("a turn is about the design's centre, counter-clockwise, and keeps the centre fixed", () => {
    const m = placementMatrix(Math.PI / 2, c, 0, 0);
    const cc = applyMatrix(m, c);
    expect(cc.x).toBeCloseTo(c.x); expect(cc.y).toBeCloseTo(c.y);
    const q = applyMatrix(m, { x: 50, y: 20 }); // the right-hand middle of the square goes to the top
    expect(q.x).toBeCloseTo(c.x); expect(q.y).toBeCloseTo(c.y + 20);
    const b = boundsOf(square.map((p) => applyMatrix(m, p)));
    expect(b.maxX - b.minX).toBeCloseTo(20); expect(b.maxY - b.minY).toBeCloseTo(40);
  });
  it("is rigid: what the server accepts (a = d, b = -c, unit length)", () => {
    const [a, b, cc, d] = placementMatrix(0.7, c, 3, 4);
    expect(a).toBeCloseTo(d); expect(b).toBeCloseTo(-cc); expect(a * a + b * b).toBeCloseTo(1);
  });
  it("knows when the design is off the bed", () => {
    expect(fitsBed(square, 400, 400)).toBe(true);
    expect(fitsBed(square.map((p) => applyMatrix(placementMatrix(0, c, 380, 0), p)), 400, 400)).toBe(false);
  });
  it("shows angles in -180..180", () => {
    expect(degrees(Math.PI * 1.5)).toBeCloseTo(-90);
    expect(degrees(Math.PI)).toBeCloseTo(180);
  });
});

// A bed bigger than the camera can see: the laser cuts known squares and the teacher clicks their corners.
describe("calibration from squares the laser cut", () => {
  const truth = solveHomography(bedCorners(400, 400), CAM)!; // bed mm -> camera px for the pretend camera
  const squares = [[120, 120], [240, 120], [120, 240], [240, 240]].map(([x, y], i) => ({ square: i + 1, corners: [[x!, y!], [x! + 40, y!], [x! + 40, y! + 40], [x!, y! + 40]] as [number, number][] }));
  const bed = targetsFromSquares(squares);
  const clicks = (noise: number) => bed.map((p, i) => { const c = applyH(truth, p); return { x: c.x + Math.sin(i * 12.9) * noise, y: c.y + Math.cos(i * 7.3) * noise }; });
  it("lists 16 targets, four per square, in the order given", () => {
    expect(bed).toHaveLength(16);
    expect(bed[0]).toEqual({ x: 120, y: 120 });
    expect(bed[5]).toEqual({ x: 280, y: 120 });
  });
  it("recovers the whole bed from clicks that only cover a small part of it", () => {
    const c = makeCalibration(clicks(0), bed, 640, 480)!;
    expect(c).not.toBeNull();
    for (const p of bedCorners(400, 400)) { // the bed corners were never clicked, and still land where they should
      const back = toBed(c, applyH(truth, p));
      expect(back.x).toBeCloseTo(p.x, 3); expect(back.y).toBeCloseTo(p.y, 3);
    }
    expect(fitError(clicks(0), bed, c.homography).worst).toBeLessThan(1e-6);
  });
  it("averages out clicking errors of a couple of pixels", () => {
    const c = makeCalibration(clicks(2), bed, 640, 480)!;
    expect(c).not.toBeNull();
    const centre = toBed(c, applyH(truth, { x: 200, y: 200 }));
    expect(Math.hypot(centre.x - 200, centre.y - 200)).toBeLessThan(2);
    expect(fitError(clicks(2), bed, c.homography).mean).toBeLessThan(3);
  });
  it("one square (four points) is solved exactly", () => {
    const c = makeCalibration(clicks(0).slice(0, 4), bed.slice(0, 4), 640, 480)!;
    expect(c).not.toBeNull();
    const m = solveHomographyLS(clicks(0).slice(0, 4), bed.slice(0, 4))!;
    expect(c.homography.map((v, i) => Math.abs(v - m[i]!))).toSatisfy((d: number[]) => d.every((x) => x < 1e-9));
  });
  it("refuses a wrongly ordered square and clicks that do not fit", () => {
    const bad = clicks(0);
    [bad[0], bad[1]] = [bad[1]!, bad[0]!];
    expect(makeCalibration(bad, bed, 640, 480)).toBeNull();
    const scattered = clicks(0).map((p, i) => (i === 9 ? { x: p.x + 90, y: p.y - 70 } : p));
    expect(makeCalibration(scattered, bed, 640, 480)).toBeNull();
  });
  it("the least-squares solver agrees with the exact one on four points and refuses too few", () => {
    const exact = solveHomography(CAM, bedCorners(400, 400))!;
    const ls = solveHomographyLS(CAM, bedCorners(400, 400))!;
    exact.forEach((v, i) => expect(ls[i]).toBeCloseTo(v, 9));
    expect(solveHomographyLS(CAM.slice(0, 3), bedCorners(400, 400).slice(0, 3))).toBeNull();
  });
});
