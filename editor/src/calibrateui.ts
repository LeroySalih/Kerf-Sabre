// Calibrate a laser's camera, from Station mode, by a teacher. Two ways, both end with the teacher clicking known bed points in the live picture:
//  - "Cut test squares" (works when the bed is bigger than the camera sees): the laser cuts squares of known size at a known place, and the
//    teacher clicks each square's corners. Many points are fitted by least squares, so spread the squares over what the camera sees.
//  - "Bed corners": the whole bed is in view, so click its four corners.
// Approximate on purpose (a flat map, no lens correction): the pupil's Frame step is the real check. See docs/BRIEF.md section 10 for the accurate version.
import { bedCorners, fitError, makeCalibration, targetsFromSquares, toCam, type Calibration } from "./alignlogic";
import { watchCamera } from "./camerafeed";
import { infoDialog } from "./dialog";
import { DEFAULT_MATERIAL_ID } from "./presets";
import { btn, el, modal, msg } from "./dom";
import type { Pt } from "./homography";
import {
  assignJob, cancelJob, createCalibrationMarks, deleteCalibration, frameJob, getCalibration, getJob, getMachine, listPresets, listStations, putCalibration,
  type MachineInfo, type MarksRequest, type Session,
} from "./server";

const NS = "http://www.w3.org/2000/svg";
const sv = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `view` is the session that fetches the camera picture; `teacher` makes the changes (a technician, teacher or admin: today the same DINO session; it was once a
 * teacher token typed in for the dialog only). Resolves true if a calibration was saved or removed.
 */
export async function openCalibration(view: Session, teacher: Session, stationId: string): Promise<boolean> {
  let loaded: [MachineInfo, Calibration | null, { id: string; material: string; thicknessMm: number }[]];
  try { loaded = await Promise.all([getMachine(teacher, stationId), getCalibration(teacher, stationId), listPresets(teacher)]); }
  catch (e) { await infoDialog("Couldn't open that", [msg(e)]); return false; }
  const [machine, existing, presets] = loaded;
  const W = machine.bed.widthMm, H = machine.bed.heightMm;

  const { dlg, show } = modal("kdialog wide");
  const title = el("h2", {}, `Calibrate the camera: ${stationId}`);
  const body = el("div");
  const stage = el("div", { class: "al-stage" }, el("p", { class: "hint" }, "Waiting for the camera picture…"));
  dlg.append(title, body, stage);

  let changed = false;
  let targets: Pt[] = [];        // the known bed points to click, in order
  let prompts: string[] = [];
  let pts: Pt[] = [];            // what has been clicked so far
  let clicking = false;
  let markJob: string | null = null;
  let running = false;
  let size: { w: number; h: number } | null = null;
  let svg: SVGSVGElement | null = null, img: SVGImageElement | null = null, layer: SVGGElement | null = null;
  let drag = -1;
  const say = el("p", { class: "st-say" });
  const info = el("p", { class: "hint" });
  const save = btn("Save calibration", () => void doSave(), "on");
  const again = btn("Start again", () => { pts = []; draw(); });

  // ---------------------------------------------------------------- the picture, with markers
  const cal = () => (size && pts.length >= 4 && pts.length % 4 === 0 ? makeCalibration(pts, targets.slice(0, pts.length), size.w, size.h) : null);

  function draw(): void {
    if (!svg || !layer || !size) return;
    layer.replaceChildren();
    const c = cal();
    if (c) {
      const cam = toCam(c);
      const line = (a: Pt, b: Pt, cls: string) => { const p = cam(a), q = cam(b); layer!.append(sv("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: cls, "pointer-events": "none" })); };
      for (let x = 0; x <= W + 1e-6; x += 50) line({ x, y: 0 }, { x, y: H }, "cal-grid");
      for (let y = 0; y <= H + 1e-6; y += 50) line({ x: 0, y }, { x: W, y }, "cal-grid");
      layer.append(sv("polygon", { class: "al-bed", points: bedCorners(W, H).map((p) => { const q = cam(p); return `${q.x},${q.y}`; }).join(" "), "pointer-events": "none" }));
    }
    pts.forEach((p, i) => {
      const g = sv("g", { class: "cal-mark" });
      g.append(sv("circle", { cx: p.x, cy: p.y, r: 8 }), sv("text", { x: p.x + 12, y: p.y - 8 }));
      g.lastElementChild!.textContent = String(i + 1);
      g.addEventListener("pointerdown", (e) => { drag = i; svg!.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
      layer!.append(g);
    });
    if (!clicking) return;
    const done = pts.length >= targets.length;
    say.textContent = !done ? prompts[pts.length]! : "All marked.";
    if (c) {
      const e = fitError(pts, targets.slice(0, pts.length), c.homography);
      info.textContent = `Fit: typically ${e.mean.toFixed(1)} mm off, at worst ${e.worst.toFixed(1)} mm. The orange grid shows where 50 mm squares of the bed land; it should line up with what you can see. Drag a marker to correct it.`;
    } else info.textContent = pts.length >= 4 && pts.length % 4 === 0 ? "Those points do not fit together (a square crosses over, goes the wrong way round, or a click is far off). Drag the odd one, or start again, clicking each square's corners in order." : pts.length ? "Drag a marker to correct it. You can save after each complete square: more squares make it more accurate." : "";
    save.disabled = !c;
    again.disabled = pts.length === 0;
  }

  const where = (e: PointerEvent): Pt => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg!.getScreenCTM()!.inverse());
    return { x: Math.min(Math.max(p.x, 0), size!.w), y: Math.min(Math.max(p.y, 0), size!.h) };
  };
  function build(url: string, w: number, h: number): void {
    size = { w, h };
    svg = sv("svg", { class: "al-svg", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Camera picture of the laser bed" });
    img = sv("image", { x: 0, y: 0, width: w, height: h, href: url });
    layer = sv("g");
    svg.append(img, layer);
    svg.addEventListener("click", (e) => { if (!clicking || drag >= 0 || pts.length >= targets.length) return; pts.push(where(e as PointerEvent)); draw(); });
    svg.addEventListener("pointermove", (e) => { if (drag >= 0) { pts[drag] = where(e); draw(); } });
    const end = () => { setTimeout(() => { drag = -1; }, 0); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    stage.replaceChildren(svg);
    draw();
  }
  const stopCamera = watchCamera(view, stationId, (url) => {
    if (!svg) { const probe = new Image(); probe.onload = () => { if (!svg) build(url, probe.naturalWidth, probe.naturalHeight); }; probe.src = url; }
    else img!.setAttribute("href", url);
  }, 1000);

  async function doSave(): Promise<void> {
    const c = cal();
    if (!c) return;
    try { await putCalibration(teacher, stationId, c); changed = true; dlg.close(); }
    catch (e) { await infoDialog("Not saved", [msg(e)]); }
  }

  // ---------------------------------------------------------------- steps
  function startClicking(bedPts: Pt[], texts: string[]): void {
    targets = bedPts; prompts = texts; pts = []; clicking = true;
    body.replaceChildren(say, info, el("div", { class: "krow" }, again, btn("Cancel", () => dlg.close()), save));
    draw();
  }

  function chooseStep(): void {
    clicking = false; pts = [];
    const remove = btn("Remove calibration", () => void (async () => {
      if (!confirm("Remove this camera's calibration? Pupils will not be able to line designs up on the picture until it is done again.")) return;
      try { await deleteCalibration(teacher, stationId); changed = true; dlg.close(); } catch (e) { await infoDialog("Not removed", [msg(e)]); }
    })(), "danger");
    body.replaceChildren(
      el("p", { class: "hint" }, existing ? `Already calibrated${existing.calibratedBy ? ` by ${existing.calibratedBy}` : ""}${existing.calibratedAt ? ` on ${new Date(existing.calibratedAt).toLocaleString()}` : ""}. You can do it again.` : "This camera has not been calibrated yet."),
      el("div", { class: "al-choices" },
        btn("Cut test squares with the laser (use this when the camera cannot see the whole bed)", () => marksStep(), "on"),
        btn(`The camera can see the whole bed: click its four corners`, () => startClicking(bedCorners(W, H), [
          `Corner 1 of 4: the machine's origin (X 0, Y 0), its ${machine.bed.originCorner} corner.`, `Corner 2 of 4: along the X axis from the origin (X ${W}, Y 0).`,
          `Corner 3 of 4: the far corner (X ${W}, Y ${H}).`, `Corner 4 of 4: along the Y axis from the origin (X 0, Y ${H}).`]))),
      el("div", { class: "krow" }, ...(existing ? [remove] : []), btn("Close", () => dlg.close())));
  }

  function marksStep(error = ""): void {
    clicking = false;
    const num = (label: string, value: number, hint: string) => { const i = el("input", { type: "number", step: "any", value: String(value) }) as HTMLInputElement; return { i, row: el("label", {}, label, i, el("span", { class: "hint" }, hint)) }; };
    const cx = num("Middle of the marks: X (mm)", Math.round(W / 2), "Where the camera is looking, measured along X from the machine's origin");
    const cy = num("Middle of the marks: Y (mm)", Math.round(H / 2), "and along Y");
    const sz = num("Square size (mm)", 40, "Each square's side");
    const sp = num("Distance between squares (mm)", 120, "Centre to centre. Spread them over what the camera sees: wider is more accurate");
    const count = el("select", {}, new Option("4 squares (best)", "4"), new Option("1 square", "1")) as HTMLSelectElement;
    const layerSel = el("select", {}, new Option("Score (a light line, material stays in one piece)", "score"), new Option("Cut through", "cut")) as HTMLSelectElement;
    const mat = el("select", {}, ...presets.map((p) => new Option(`${p.material} ${p.thicknessMm} mm`, p.id))) as HTMLSelectElement;
    mat.value = presets.find((p) => p.id === DEFAULT_MATERIAL_ID)?.id ?? presets[0]?.id ?? ""; // plywood, not whatever sorts first
    const extent = el("p", { class: "hint" });
    const upd = () => {
      const n = count.value === "4", half = (n ? parseFloat(sp.i.value) / 2 : 0) + parseFloat(sz.i.value) / 2;
      extent.textContent = Number.isFinite(half) ? `The marks will cover X ${Math.round(parseFloat(cx.i.value) - half)} to ${Math.round(parseFloat(cx.i.value) + half)} mm and Y ${Math.round(parseFloat(cy.i.value) - half)} to ${Math.round(parseFloat(cy.i.value) + half)} mm. Put a scrap of material at least that big under the camera, and do not move it until you have clicked the corners.` : "";
    };
    [cx.i, cy.i, sz.i, sp.i, count].forEach((x) => x.addEventListener("input", upd));
    upd();
    body.replaceChildren(
      el("p", { class: "hint" }, "The laser will cut squares of a known size at a known place on a scrap of material. Then you click their corners in the camera picture."),
      ...(error ? [el("p", { class: "st-error", role: "alert" }, error)] : []),
      el("div", { class: "kgrid" }, cx.row, cy.row, sz.row, sp.row, el("label", {}, "Squares", count), el("label", {}, "Line", layerSel), el("label", {}, "Material", mat)),
      extent,
      el("div", { class: "krow" }, btn("Back", () => chooseStep()), btn("Cut the squares", () => void runMarks({
        centerX: parseFloat(cx.i.value), centerY: parseFloat(cy.i.value), sizeMm: parseFloat(sz.i.value), spacingMm: parseFloat(sp.i.value),
        count: count.value === "1" ? 1 : 4, layer: layerSel.value as "score" | "cut", presetId: mat.value }), "go")));
  }

  async function runMarks(req: MarksRequest): Promise<void> {
    if (running) return;
    running = true; markJob = null;
    const status = el("p", { class: "st-say", role: "status" }, "Making the job…");
    const cancel = btn("Cancel", () => { stopped = true; });
    let stopped = false;
    body.replaceChildren(status, el("p", { class: "hint" }, "Stand clear of the laser. It will trace the outline first (laser off), then cut."), el("div", { class: "krow" }, cancel));
    const stationNow = async () => (await listStations(view)).find((x) => x.id === stationId);
    const until = async (what: string, ok: () => Promise<boolean>, seconds: number) => {
      for (let t = 0; t < seconds * 2; t++) { if (stopped) throw new Error("Cancelled."); if (await ok()) return; await sleep(500); }
      throw new Error(`Timed out waiting for ${what}.`);
    };
    try {
      const made = await createCalibrationMarks(teacher, stationId, req);
      markJob = made.jobId;
      status.textContent = "The laser is tracing the outline (laser off)…";
      await frameJob(teacher, made.jobId, stationId, { skipQueue: true });
      await sleep(600);
      await until("the laser to finish tracing", async () => { const s = await stationNow(); return !!s && (s.state === "Idle" || !s.state); }, 90);
      status.textContent = "Cutting the squares…";
      await assignJob(teacher, made.jobId, stationId, true, { skipQueue: true, allowUntested: true });
      await until("the squares to be cut", async () => { const j = await getJob(teacher, made.jobId); if (j.status === "failed" || j.status === "cancelled") throw new Error(`The laser stopped: ${j.statusReason ?? j.status}`); return j.status === "done"; }, 900);
      markJob = null; // done: nothing left to cancel
      const squares = made.squares;
      startClicking(targetsFromSquares(squares), squares.flatMap((q) => q.corners.map((_, i) => `Square ${q.square} of ${squares.length}, corner ${i + 1} of 4 (the ${["lower-left", "lower-right", "upper-right", "upper-left"][i]} corner, bed X ${q.corners[i]![0]}, Y ${q.corners[i]![1]}). Click it in the picture.`)));
      info.textContent = "Do not move the material. The corners are the lines' outer corners.";
    } catch (e) {
      if (markJob) { try { await cancelJob(teacher, markJob); } catch { /* it may already have started */ } markJob = null; }
      marksStep(msg(e));
    } finally { running = false; }
  }

  dlg.addEventListener("close", () => { stopCamera(); if (markJob && !running) void cancelJob(teacher, markJob).catch(() => {}); });
  chooseStep();
  await show();
  return changed;
}
