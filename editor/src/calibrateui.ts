// Teacher: tell the Editor where the camera picture sits on the bed, by clicking the bed's four corners once per laser.
// Approximate on purpose (a flat map, no lens correction): the Frame step is the real check. See docs/BRIEF.md section 10 for the accurate version.
import { makeCalibration, toCam, bedCorners, type Calibration } from "./alignlogic";
import { watchCamera } from "./camerafeed";
import { infoDialog } from "./dialog";
import { btn, el, modal, msg } from "./dom";
import type { Pt } from "./homography";
import { deleteCalibration, getCalibration, getMachine, putCalibration, type MachineInfo, type Session } from "./server";

const NS = "http://www.w3.org/2000/svg";
const sv = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** Resolves true if a calibration was saved or removed. */
export async function openCalibration(session: Session, stationId: string): Promise<boolean> {
  let loaded: [MachineInfo, Calibration | null];
  try { loaded = await Promise.all([getMachine(session, stationId), getCalibration(session, stationId)]); }
  catch (e) { await infoDialog("Couldn't open that", [msg(e)]); return false; }
  const [machine, existing] = loaded;
  const W = machine.bed.widthMm, H = machine.bed.heightMm;
  const prompts = [
    `Corner 1 of 4: the machine's origin (X 0, Y 0). Its ${machine.bed.originCorner} corner.`,
    `Corner 2 of 4: along the X axis from the origin (X ${W}, Y 0).`,
    `Corner 3 of 4: the far corner (X ${W}, Y ${H}).`,
    `Corner 4 of 4: along the Y axis from the origin (X 0, Y ${H}).`,
  ];
  const { dlg, show } = modal("kdialog wide");
  const say = el("p", { class: "st-say" });
  const stage = el("div", { class: "al-stage" }, el("p", { class: "hint" }, "Waiting for the camera picture…"));
  const status = el("p", { class: "hint" });
  const save = btn("Save calibration", () => void doSave(), "on");
  const again = btn("Start again", () => { pts = []; draw(); });
  const remove = btn("Remove calibration", () => void (async () => { if (confirm("Remove this camera's calibration? Pupils will not be able to line designs up on the picture until it is done again.")) { try { await deleteCalibration(session, stationId); changed = true; dlg.close(); } catch (e) { await infoDialog("Not removed", [msg(e)]); } } })(), "danger");
  dlg.append(el("h2", {}, `Calibrate the camera: ${stationId}`),
    el("p", { class: "hint" }, "Put the laser bed so its four corners can be seen, then click the bed's corners in the order asked. Drag a marker to correct it. The orange grid shows where 50 mm squares of the bed will land; it should sit on the real bed."),
    say, stage, status,
    el("div", { class: "krow" }, ...(existing ? [remove] : []), again, btn("Cancel", () => dlg.close()), save));
  let pts: Pt[] = [];
  let changed = false;
  let size: { w: number; h: number } | null = null;
  let svg: SVGSVGElement | null = null;
  let img: SVGImageElement | null = null;
  let layer: SVGGElement | null = null;

  const cal = () => (size && pts.length === 4 ? makeCalibration(pts, W, H, size.w, size.h) : null);

  function draw(): void {
    if (!svg || !layer || !size) return;
    layer.replaceChildren();
    const c = cal();
    if (c) {
      const cam = toCam(c);
      const line = (a: Pt, b: Pt, cls: string) => { const p = cam(a), q = cam(b); layer!.append(sv("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: cls, "pointer-events": "none" })); };
      for (let x = 0; x <= W + 1e-6; x += 50) line({ x, y: 0 }, { x, y: H }, "cal-grid");
      for (let y = 0; y <= H + 1e-6; y += 50) line({ x: 0, y }, { x: W, y }, "cal-grid");
      const corners = bedCorners(W, H);
      layer.append(sv("polygon", { class: "al-bed", points: corners.map((p) => { const q = cam(p); return `${q.x},${q.y}`; }).join(" "), "pointer-events": "none" }));
    }
    pts.forEach((p, i) => {
      const g = sv("g", { class: "cal-mark", tabindex: "-1" });
      g.append(sv("circle", { cx: p.x, cy: p.y, r: 10 }), sv("text", { x: p.x + 14, y: p.y - 10 }));
      g.lastElementChild!.textContent = String(i + 1);
      g.addEventListener("pointerdown", (e) => { drag = i; svg!.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
      layer!.append(g);
    });
    say.textContent = pts.length < 4 ? prompts[pts.length]! : c ? "All four marked. Check the orange grid sits on the bed, then save." : "Those four points do not make a bed shape (they cross over or go the wrong way round). Start again, going round in order.";
    status.textContent = existing && pts.length === 0 ? `Calibrated by ${existing.calibratedBy ?? "someone"}${existing.calibratedAt ? ` on ${new Date(existing.calibratedAt).toLocaleString()}` : ""}. Click corner 1 to redo it.` : "";
    save.disabled = !c;
    again.disabled = pts.length === 0;
  }

  let drag = -1;
  const where = (e: PointerEvent): Pt => {
    const m = svg!.getScreenCTM()!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.min(Math.max(p.x, 0), size!.w), y: Math.min(Math.max(p.y, 0), size!.h) };
  };

  function build(url: string, w: number, h: number): void {
    size = { w, h };
    svg = sv("svg", { class: "al-svg", viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Camera picture: click the bed corners" });
    img = sv("image", { x: 0, y: 0, width: w, height: h, href: url });
    layer = sv("g");
    svg.append(img, layer);
    svg.addEventListener("click", (e) => { if (drag >= 0 || pts.length >= 4) return; pts.push(where(e as PointerEvent)); draw(); });
    svg.addEventListener("pointermove", (e) => { if (drag >= 0) { pts[drag] = where(e); draw(); } });
    const end = () => { setTimeout(() => { drag = -1; }, 0); };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    stage.replaceChildren(svg);
    draw();
  }

  const stop = watchCamera(session, stationId, (url) => {
    if (!svg) { const probe = new Image(); probe.onload = () => { if (!svg) build(url, probe.naturalWidth, probe.naturalHeight); }; probe.src = url; }
    else img!.setAttribute("href", url);
  }, 1000);

  async function doSave(): Promise<void> {
    const c = cal();
    if (!c) return;
    try { await putCalibration(session, stationId, c); changed = true; dlg.close(); }
    catch (e) { await infoDialog("Not saved", [msg(e)]); }
  }

  draw();
  await show();
  stop();
  return changed;
}
