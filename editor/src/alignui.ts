// Station mode: line the design up on the camera picture. The design floats over the live picture; drag it, turn it with the
// knob or the buttons, and Confirm fixes its position on the bed. The picture and the outline live in ONE svg whose units are
// camera pixels, so they always stay registered; the calibration's homography turns bed mm into those pixels.
import { angleOf, applyMatrix, boundsOf, centreOf, degrees, designShapes, fitsBed, placementMatrix, toBed, toCam, type Calibration } from "./alignlogic";
import { watchCamera } from "./camerafeed";
import type { Pt } from "./homography";
import type { JobObject } from "./job";
import type { Session } from "./server";

const NS = "http://www.w3.org/2000/svg";
const s = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (string | Node)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

export interface AlignOptions {
  session: Session;
  stationId: string;
  objects: JobObject[];
  calibration: Calibration;
  bed: { widthMm: number; heightMm: number };
  /** Called with the rigid matrix [a,b,c,d,e,f] when the pupil confirms. Resolves when it has been saved. */
  onConfirm: (matrix: number[]) => Promise<void>;
  onCancel: () => void;
}

export interface AlignView { el: HTMLElement; destroy: () => void }

export function createAlignView(o: AlignOptions): AlignView {
  const cal = o.calibration, W = cal.imageWidth, H = cal.imageHeight;
  const cam = toCam(cal);
  const shapes = designShapes(o.objects);
  const all = shapes.flatMap((sh) => sh.pts);
  const c0 = centreOf(all);
  const box = boundsOf(all);
  const knobMm = Math.max(box.maxY - box.minY, 20) / 2 + 18; // how far above the centre the turning knob sits, in the design's own frame
  let rot = 0, dx = 0, dy = 0, saving = false, warned = "";

  // ---- the picture
  const svg = s("svg", { class: "al-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Camera view of the laser bed with your design on top", tabindex: "0" });
  const img = s("image", { x: 0, y: 0, width: W, height: H, href: "" });
  const bedFrame = s("polygon", { class: "al-bed", points: [[0, 0], [o.bed.widthMm, 0], [o.bed.widthMm, o.bed.heightMm], [0, o.bed.heightMm]].map(([x, y]) => { const p = cam({ x: x!, y: y! }); return `${p.x},${p.y}`; }).join(" ") });
  const waiting = s("text", { x: W / 2, y: H / 2, class: "al-wait", "text-anchor": "middle" });
  waiting.textContent = "Waiting for the camera picture…";
  const grab = s("polygon", { class: "al-grab" });
  const lines = shapes.map((sh) => s(sh.closed ? "polygon" : "polyline", { class: `al-shape ${sh.layer}`, "pointer-events": "none" }));
  const stem = s("line", { class: "al-stem", "pointer-events": "none" });
  const knob = s("circle", { class: "al-knob", r: 11 });
  svg.append(img, bedFrame, waiting, grab, ...lines, stem, knob);

  const where = (e: PointerEvent): Pt => {
    const m = svg.getScreenCTM();
    if (!m) return { x: NaN, y: NaN };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const matrix = () => placementMatrix(rot, c0, dx, dy);
  const placed = (pts: Pt[]) => pts.map((p) => applyMatrix(matrix(), p));
  const camStr = (pts: Pt[]) => pts.map((p) => { const q = cam(p); return `${Math.round(q.x * 10) / 10},${Math.round(q.y * 10) / 10}`; }).join(" ");

  // ---- readout and buttons
  const readout = h("p", { class: "al-readout", role: "status" });
  const warn = h("p", { class: "st-error", role: "alert" });
  const confirmBtn = h("button", { type: "button", class: "go" }, "Confirm position");
  const cancelBtn = h("button", { type: "button", class: "link" }, "Cancel");
  const nudge = (label: string, title: string, fn: () => void) => { const b = h("button", { type: "button", title, "aria-label": title }, label); b.addEventListener("click", fn); return b; };
  // "up" on screen is up the camera picture; in bed mm that is whichever way the calibration says
  const step = (sx: number, sy: number, mm: number) => { // move so the design shifts mm along the picture's (sx, sy) direction
    const c = cam(applyMatrix(matrix(), c0));
    const t = toBed(cal, { x: c.x + sx * 10, y: c.y + sy * 10 }), b = toBed(cal, c);
    const len = Math.hypot(t.x - b.x, t.y - b.y) || 1;
    dx += ((t.x - b.x) / len) * mm; dy += ((t.y - b.y) / len) * mm; draw();
  };
  const turn = (deg: number) => { rot += (deg * Math.PI) / 180; draw(); };
  const pad = h("div", { class: "al-pad" },
    nudge("◀", "Move left 1 mm", () => step(-1, 0, 1)), nudge("▲", "Move up 1 mm", () => step(0, -1, 1)), nudge("▼", "Move down 1 mm", () => step(0, 1, 1)), nudge("▶", "Move right 1 mm", () => step(1, 0, 1)),
    nudge("⟲ 1°", "Turn 1 degree anticlockwise", () => turn(1)), nudge("⟳ 1°", "Turn 1 degree clockwise", () => turn(-1)),
    nudge("Reset", "Put the design back where it started", () => { rot = dx = dy = 0; draw(); }));

  function draw(): void {
    const pts = shapes.map((sh) => placed(sh.pts));
    lines.forEach((ln, i) => ln.setAttribute("points", camStr(pts[i]!)));
    const b = boundsOf(pts.flat());
    grab.setAttribute("points", camStr([{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]));
    const centre = applyMatrix(matrix(), c0);
    const knobBed = applyMatrix(matrix(), { x: c0.x, y: c0.y + knobMm });
    const kc = cam(knobBed), cc = cam(centre);
    knob.setAttribute("cx", String(kc.x)); knob.setAttribute("cy", String(kc.y));
    stem.setAttribute("x1", String(cc.x)); stem.setAttribute("y1", String(cc.y)); stem.setAttribute("x2", String(kc.x)); stem.setAttribute("y2", String(kc.y));
    const ok = fitsBed(pts.flat(), o.bed.widthMm, o.bed.heightMm);
    readout.textContent = `Centre of design: X ${centre.x.toFixed(1)} mm, Y ${centre.y.toFixed(1)} mm · turned ${degrees(rot).toFixed(1)}°`;
    warn.textContent = ok ? warned : "Part of the design is off the bed. Move it back inside the orange line.";
    confirmBtn.disabled = !ok || saving;
    confirmBtn.textContent = saving ? "Saving…" : "Confirm position";
  }

  // ---- dragging: the design moves by exactly how far the pointer moved on the bed; the knob turns it about its centre
  type Drag = { kind: "move"; start: Pt; dx: number; dy: number } | { kind: "turn"; start: number; rot: number; centre: Pt };
  let drag: Drag | null = null;
  grab.addEventListener("pointerdown", (e) => { const p = toBed(cal, where(e)); drag = { kind: "move", start: p, dx, dy }; svg.setPointerCapture(e.pointerId); e.preventDefault(); });
  knob.addEventListener("pointerdown", (e) => {
    const centre = applyMatrix(matrix(), c0);
    drag = { kind: "turn", start: angleOf(centre, toBed(cal, where(e))), rot, centre };
    svg.setPointerCapture(e.pointerId); e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toBed(cal, where(e));
    if (!Number.isFinite(p.x)) return;
    if (drag.kind === "move") { dx = drag.dx + (p.x - drag.start.x); dy = drag.dy + (p.y - drag.start.y); }
    else rot = drag.rot + (angleOf(drag.centre, p) - drag.start);
    draw();
  });
  const end = () => { drag = null; };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("keydown", (e) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return;
    step(k[0]!, k[1]!, e.shiftKey ? 10 : 1); e.preventDefault();
  });

  confirmBtn.addEventListener("click", () => {
    if (saving) return;
    saving = true; warned = ""; draw();
    void o.onConfirm(matrix()).catch((err) => { warned = err instanceof Error ? err.message : String(err); }).finally(() => { saving = false; draw(); });
  });
  cancelBtn.addEventListener("click", () => o.onCancel());

  // ---- the live picture (a different size from the one calibrated would not line up, so say so)
  let sizeWarned = false;
  const stop = watchCamera(o.session, o.stationId, (url) => {
    const probe = new Image();
    probe.onload = () => {
      if (!sizeWarned && (probe.naturalWidth !== W || probe.naturalHeight !== H)) { sizeWarned = true; warned = "The camera picture is a different size from when it was calibrated, so the outline may be in the wrong place. Ask a teacher to calibrate again."; draw(); }
    };
    probe.src = url;
    img.setAttribute("href", url);
    waiting.setAttribute("display", "none");
  });

  const el = h("div", { class: "al" },
    h("p", { class: "al-help" }, "Drag the design onto your material. Drag the round knob to turn it. The orange line is the edge of the laser bed."),
    h("div", { class: "al-stage" }, svg), readout, warn, pad,
    h("div", { class: "st-actions" }, confirmBtn, cancelBtn),
    h("p", { class: "hint" }, "The picture is slightly curved near the edges, so after you confirm, press Frame: the laser traces the outline (laser off) to double-check."));
  draw();
  return { el, destroy: () => { stop(); } };
}
