import paper from "paper";
import { bedToScreen, fitView, panBy, screenToBed, zoomAt, type Point, type View } from "./coords";
import { Doc, type DocObject, type LayerType } from "./doc";
import { DEFAULT_MM_PER_UNIT, designMin, mmPerUnit, parseDXF, scalePath } from "./dxf-import";
import { toDXF, toSVG } from "./export";
import { IDENTITY, arcMid, circle, line, multiply, polylinePath, rectangle, regularPolygon, translation, transformPath, type Matrix, type Path } from "./geometry";
import { GIZMO, gizmoAngle, gizmoMatrix, gizmoPoints, hitGizmo, type Handle } from "./gizmo";
import { DEFAULT_ANCHOR, anchorPoint, deltaToAnchor, rotateAboutAnchor, scaleAboutAnchor, scaleBy, selectionBounds, type Anchor, type Axis } from "./anchor";
import { boundsOf, type Bounds } from "./geometry";
import { planTrim } from "./trim";
import { booleanOp, type BoolOp } from "./boolean";
import { outOfBounds } from "./bounds";
import { snapTo, type SnapKind } from "./snap";
import { DEFAULT_FONT, getFont, listFonts, loadBundledFonts, registerOutlineFont, textToPaths, type TextSpec } from "./text";
import { selectionSummary } from "./status";
import { formatMeasurement, measure, rulerTicks } from "./ruler";
import { boxMode, boxSelect, rectOf } from "./select";
import { loadMachineProfiles, type MachineProfile } from "./machine";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const select = document.getElementById("machine") as HTMLSelectElement;
const cursorEl = document.getElementById("cursor") as HTMLElement;

const profiles = loadMachineProfiles();
let machine: MachineProfile = profiles[0]!;
let view: View;
const doc = new Doc();
let selected = new Set<number>();
type Tool = "select" | "rect" | "circle" | "line" | "polygon" | "pen" | "trim" | "measure" | "text";
let tool: Tool = "select";
let showGrid = true;
let spaceDown = false;
let penPoints: Point[] = []; // vertices placed so far by the Pen tool (bed mm)
let penCursor: Point | null = null; // snapped cursor, for the rubber band
let showGimbal = false;
let gizmoHover: Handle | null = null;
let gizmoDrag: { handle: Handle; pivot: Point; start: Point; mats: Map<number, Matrix>; started: boolean; label: string } | null = null;
let snapOn = true;
let snapMarker: { pt: Point; kind: SnapKind } | null = null;
let moveBounds: Bounds | null = null; // selection bounds when a drag-move began
let moveApplied: Point = { x: 0, y: 0 }; // total translation applied so far this drag
let panning: { x: number; y: number } | null = null;
let anchor: Anchor = DEFAULT_ANCHOR;
let trimPreview: Path | null = null;
let measureLine: { a: Point; b: Point } | null = null;
const RULER = 20; // ruler thickness in px
let marquee: { a: Point; b: Point; base: Set<number> } | null = null;
let preview: { tool: Tool; a: Point; b: Point } | null = null;

paper.setup(canvas);

const COLOURS: Record<LayerType, string> = { score: "#2563eb", cut: "#dc2626" };
const toScreen = (p: Point) => new paper.Point(bedToScreen(view, p).x, bedToScreen(view, p).y);

function toPaperPath(path: Path): paper.Path {
  const pp = new paper.Path();
  pp.moveTo(toScreen(path.start));
  let cur = path.start;
  for (const s of path.segs) {
    if (s.t === "l") pp.lineTo(toScreen(s.to));
    else if (s.t === "c") pp.cubicCurveTo(toScreen(s.c1), toScreen(s.c2), toScreen(s.to));
    else pp.arcTo(toScreen(arcMid(s.c, cur, s.to, s.ccw)), toScreen(s.to));
    cur = s.to;
  }
  pp.closed = path.closed;
  return pp;
}

const sidesEl = document.getElementById("sides") as HTMLInputElement;
const sides = () => Math.min(64, Math.max(3, Math.round(parseFloat(sidesEl.value) || 6)));

function shapeFor(t: Tool, a: Point, b: Point): { path: Path; at: Point } | null {
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (t === "rect" && w > 0.1 && h > 0.1) return { path: rectangle(w, h), at: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) } };
  if (t === "circle") { const r = Math.hypot(b.x - a.x, b.y - a.y); if (r > 0.1) return { path: circle(r), at: a }; }
  if (t === "polygon") { const r = Math.hypot(b.x - a.x, b.y - a.y); if (r > 0.1) return { path: regularPolygon(sides(), r, Math.atan2(b.y - a.y, b.x - a.x)), at: a }; }
  if (t === "line" && Math.hypot(w, h) > 0.1) return { path: line(b.x - a.x, b.y - a.y), at: a };
  return null;
}

const pxEl = document.getElementById("px") as HTMLInputElement;
const pyEl = document.getElementById("py") as HTMLInputElement;
const pwEl = document.getElementById("pw") as HTMLInputElement;
const phEl = document.getElementById("ph") as HTMLInputElement;
const psxEl = document.getElementById("psx") as HTMLInputElement;
const psyEl = document.getElementById("psy") as HTMLInputElement;
const protEl = document.getElementById("prot") as HTMLInputElement;
const lockEl = document.getElementById("lock") as HTMLInputElement;
const fieldEls = [pxEl, pyEl, pwEl, phEl, psxEl, psyEl, protEl];
const round = (n: number) => String(Math.round(n * 1000) / 1000);

/** Show the selection's anchor position and size (bed mm); disabled when nothing is selected. */
function updatePositionFields(): void {
  refreshTextPanel();
  const b = selectionBounds(doc.state.objects, selected);
  document.getElementById("selinfo")!.textContent = selectionSummary(selected.size, b);
  for (const el of fieldEls) el.disabled = !b;
  if (!b) { for (const el of fieldEls) el.value = ""; return; }
  const p = anchorPoint(b, anchor);
  const values = [p.x, p.y, b.maxX - b.minX, b.maxY - b.minY, 100, 100, 0]; // scale and rotate are relative: always reset
  fieldEls.forEach((el, i) => { if (document.activeElement !== el) el.value = round(values[i]!); });
}

/** Move the selection so its anchor lands on the typed value. Only the edited axis changes. */
function applyPosition(axis: "x" | "y"): void {
  const b = selectionBounds(doc.state.objects, selected);
  const v = parseFloat((axis === "x" ? pxEl : pyEl).value);
  if (!b || !Number.isFinite(v)) { updatePositionFields(); return; }
  const d = deltaToAnchor(b, anchor, { [axis]: v });
  if (d.x === 0 && d.y === 0) return;
  edit(() => { for (const id of selected) doc.transform(id, translation(d.x, d.y)); });
}

/** Resize the selection about its anchor. Invalid or impossible sizes snap the field back. */
function applySize(axis: Axis): void {
  const b = selectionBounds(doc.state.objects, selected);
  const m = b && scaleAboutAnchor(b, anchor, axis, parseFloat((axis === "w" ? pwEl : phEl).value), lockEl.checked);
  if (!m) { updatePositionFields(); return; }
  edit(() => { for (const id of selected) doc.transform(id, m); });
}

/** Scale by a percentage of the current size about the anchor (lock ratio applies the edited value to both). */
function applyScale(axis: "x" | "y"): void {
  const b = selectionBounds(doc.state.objects, selected);
  const v = parseFloat((axis === "x" ? psxEl : psyEl).value) / 100;
  const m = b && scaleBy(b, anchor, axis === "x" || lockEl.checked ? v : 1, axis === "y" || lockEl.checked ? v : 1);
  if (!m) { updatePositionFields(); return; }
  edit(() => { for (const id of selected) doc.transform(id, m); });
}

/** Rotate by the typed angle about the anchor. */
function applyRotation(): void {
  const b = selectionBounds(doc.state.objects, selected);
  const m = b && rotateAboutAnchor(b, anchor, parseFloat(protEl.value));
  if (!m) { updatePositionFields(); return; }
  edit(() => { for (const id of selected) doc.transform(id, m); });
}

pxEl.addEventListener("change", () => applyPosition("x"));
psxEl.addEventListener("change", () => applyScale("x"));
psyEl.addEventListener("change", () => applyScale("y"));
protEl.addEventListener("change", applyRotation);
pyEl.addEventListener("change", () => applyPosition("y"));
pwEl.addEventListener("change", () => applySize("w"));
phEl.addEventListener("change", () => applySize("h"));
for (const el of fieldEls) el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
document.querySelectorAll<HTMLInputElement>('input[name="anchor"]').forEach((r) =>
  r.addEventListener("change", () => {
    anchor = { col: Number(r.dataset.col), row: Number(r.dataset.row) } as Anchor;
    updatePositionFields();
  }),
);

/** 1 cm grid inside the bed, heavier every 10 cm. Hidden when lines would be under ~5 px apart. */
function drawGrid(widthMm: number, heightMm: number): void {
  const STEP = 10;
  if (STEP * view.scale < 5) return;
  const line = (a: Point, b: Point, major: boolean) => {
    const p = new paper.Path.Line(toScreen(a), toScreen(b));
    p.strokeColor = new paper.Color(major ? "#9ca3af" : "#d1d5db");
    p.strokeWidth = major ? 1 : 0.5;
  };
  for (let x = 0; x <= widthMm; x += STEP) line({ x, y: 0 }, { x, y: heightMm }, x % 100 === 0);
  for (let y = 0; y <= heightMm; y += STEP) line({ x: 0, y }, { x: widthMm, y }, y % 100 === 0);
}

const GIZMO_COLOURS = { x: "#ea580c", y: "#16a34a", ring: "#7c3aed", centre: "#374151", uniform: "#0284c7" };

/** Gimbal at the selection's anchor point (screen-space, fixed pixel size). */
function drawGizmo(): void {
  if (!showGimbal || tool !== "select" || !selected.size) return;
  const b = selectionBounds(doc.state.objects, selected);
  const pivot = gizmoDrag?.pivot ?? (b ? anchorPoint(b, anchor) : null);
  if (!pivot) return;
  const c = toScreen(pivot);
  const g = gizmoPoints({ x: c.x, y: c.y });
  const active = (h: Handle) => gizmoDrag?.handle === h || (!gizmoDrag && gizmoHover === h);
  const pt = (q: Point) => new paper.Point(q.x, q.y);

  const ring = new paper.Path.Circle(c, GIZMO.ring);
  ring.strokeColor = new paper.Color(GIZMO_COLOURS.ring);
  ring.strokeWidth = active("rotate") ? 4 : 2;
  ring.opacity = active("rotate") ? 1 : 0.7;

  const axis = (tip: Point, colour: string, h: Handle, head: [Point, Point]) => {
    const w = active(h) ? 4 : 2.5;
    const shaft = new paper.Path.Line(c, pt(tip));
    shaft.strokeColor = new paper.Color(colour);
    shaft.strokeWidth = w;
    const tri = new paper.Path([pt(tip), pt(head[0]), pt(head[1])]);
    tri.closed = true;
    tri.fillColor = new paper.Color(colour);
  };
  axis(g.tipX, GIZMO_COLOURS.x, "move-x", [{ x: g.tipX.x - 12, y: g.tipX.y - 6 }, { x: g.tipX.x - 12, y: g.tipX.y + 6 }]);
  axis(g.tipY, GIZMO_COLOURS.y, "move-y", [{ x: g.tipY.x - 6, y: g.tipY.y + 12 }, { x: g.tipY.x + 6, y: g.tipY.y + 12 }]);

  const box = (q: Point, half: number, colour: string, h: Handle) => {
    const r = new paper.Path.Rectangle(new paper.Point(q.x - half, q.y - half), new paper.Size(half * 2, half * 2));
    r.fillColor = new paper.Color(active(h) ? colour : "#ffffff");
    r.strokeColor = new paper.Color(colour);
    r.strokeWidth = 2;
  };
  box(g.scaleX, GIZMO.square, GIZMO_COLOURS.x, "scale-x");
  box(g.scaleY, GIZMO.square, GIZMO_COLOURS.y, "scale-y");
  box(g.scaleUniform, GIZMO.square, GIZMO_COLOURS.uniform, "scale");
  box(g.centre, GIZMO.centre, GIZMO_COLOURS.centre, "move");

  if (gizmoDrag?.label) {
    const t = new paper.PointText({ point: new paper.Point(c.x + 14, c.y + 28), content: gizmoDrag.label, fontSize: 13, fontWeight: "bold", fillColor: new paper.Color("#111827") });
    const bg = new paper.Path.Rectangle(t.bounds.expand(4));
    bg.fillColor = new paper.Color(1, 1, 1, 0.92);
    t.insertAbove(bg);
  }
}

function drawSnapMarker(pt: Point, kind: SnapKind): void {
  const c = toScreen(pt);
  const box = new paper.Path.Rectangle(new paper.Point(c.x - 6, c.y - 6), new paper.Size(12, 12));
  box.strokeColor = new paper.Color("#059669");
  box.strokeWidth = 2;
  new paper.PointText({ point: c.add(new paper.Point(10, -8)), content: kind, fontSize: 11, fontWeight: "bold", fillColor: new paper.Color("#047857") });
}

function drawMeasure(a: Point, b: Point): void {
  const line = new paper.Path.Line(toScreen(a), toScreen(b));
  line.strokeColor = new paper.Color("#7c3aed");
  line.strokeWidth = 1.5;
  for (const p of [a, b]) {
    const dot = new paper.Path.Circle(toScreen(p), 3);
    dot.fillColor = new paper.Color("#7c3aed");
  }
  const mid = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const label = new paper.PointText({ point: mid.add(new paper.Point(8, -8)), content: formatMeasurement(measure(a, b)), fontSize: 12, fillColor: new paper.Color("#4c1d95"), fontWeight: "bold" });
  const bg = new paper.Path.Rectangle(label.bounds.expand(4));
  bg.fillColor = new paper.Color(1, 1, 1, 0.9);
  label.insertAbove(bg);
}

/** mm rulers along the top and left edges; they follow zoom and pan. */
function drawRulers(): void {
  const w = paper.view.viewSize.width, h = paper.view.viewSize.height;
  const strip = (x: number, y: number, rw: number, rh: number) => {
    const r = new paper.Path.Rectangle(new paper.Point(x, y), new paper.Size(rw, rh));
    r.fillColor = new paper.Color("#e5e7eb");
  };
  strip(0, 0, w, RULER);
  strip(0, 0, RULER, h);
  const ink = new paper.Color("#374151");
  for (const t of rulerTicks(view, "x", w)) {
    if (t.px < RULER) continue;
    const len = t.major ? RULER : RULER * 0.4;
    const l = new paper.Path.Line(new paper.Point(t.px, RULER - len), new paper.Point(t.px, RULER));
    l.strokeColor = ink; l.strokeWidth = 1;
    if (t.major) new paper.PointText({ point: new paper.Point(t.px + 2, 9), content: String(t.mm), fontSize: 9, fillColor: ink });
  }
  for (const t of rulerTicks(view, "y", h)) {
    if (t.px < RULER) continue;
    const len = t.major ? RULER : RULER * 0.4;
    const l = new paper.Path.Line(new paper.Point(RULER - len, t.px), new paper.Point(RULER, t.px));
    l.strokeColor = ink; l.strokeWidth = 1;
    if (t.major) new paper.PointText({ point: new paper.Point(1, t.px - 2), content: String(t.mm), fontSize: 9, fillColor: ink });
  }
  const corner = new paper.Path.Rectangle(new paper.Point(0, 0), new paper.Size(RULER, RULER));
  corner.fillColor = new paper.Color("#d1d5db");
  new paper.PointText({ point: new paper.Point(3, 14), content: "mm", fontSize: 8, fillColor: ink });
}

function draw(): void {
  paper.project.clear();
  const { widthMm, heightMm } = machine.bed;
  const a = bedToScreen(view, { x: 0, y: 0 });
  const b = bedToScreen(view, { x: widthMm, y: heightMm });
  const bed = new paper.Path.Rectangle(new paper.Point(a.x, b.y), new paper.Point(b.x, a.y));
  bed.strokeColor = new paper.Color("#1f2937");
  bed.fillColor = new paper.Color("#f3f4f6");
  new paper.Path.Circle(new paper.Point(a.x, a.y), 4).fillColor = new paper.Color("#f97316");

  if (showGrid) drawGrid(widthMm, heightMm);

  const oob = new Set(outOfBounds(doc.state.objects, machine.bed));
  document.getElementById("warn")!.textContent = oob.size
    ? `${oob.size} object${oob.size > 1 ? "s" : ""} outside the bed: fix before submitting`
    : "";

  for (const o of doc.state.objects) {
    const item = toPaperPath(transformPath(o.path, o.matrix));
    item.data = { id: o.id };
    const out = oob.has(o.id);
    item.strokeColor = new paper.Color(out ? "#ff0000" : COLOURS[o.layer]);
    item.strokeWidth = selected.has(o.id) || out ? 3 : 1.5;
    if (o.path.closed) item.fillColor = out ? new paper.Color(1, 0, 0, 0.18) : new paper.Color(0, 0, 0, 0.01); // faint fill keeps it hit-testable
    if (selected.has(o.id) && o.group === undefined) item.dashArray = [6, 3]; // grouped shapes get the group outline instead
  }
  for (const g of new Set(doc.state.objects.filter((o) => selected.has(o.id) && o.group !== undefined).map((o) => o.group))) {
    const bs = doc.state.objects.filter((o) => o.group === g).map((o) => boundsOf(transformPath(o.path, o.matrix)));
    const tl = bedToScreen(view, { x: Math.min(...bs.map((b) => b.minX)), y: Math.max(...bs.map((b) => b.maxY)) });
    const br = bedToScreen(view, { x: Math.max(...bs.map((b) => b.maxX)), y: Math.min(...bs.map((b) => b.minY)) });
    const box = new paper.Path.Rectangle(new paper.Point(tl.x - 4, tl.y - 4), new paper.Point(br.x + 4, br.y + 4));
    box.strokeColor = new paper.Color("#2563eb");
    box.dashArray = [2, 3];
  }
  if (penPoints.length) {
    const pts = penCursor ? [...penPoints, penCursor] : penPoints;
    const g = new paper.Path();
    pts.forEach((q) => g.add(toScreen(q)));
    g.strokeColor = new paper.Color("#6b7280");
    g.strokeWidth = 1.5;
    g.dashArray = [4, 4];
    penPoints.forEach((q, i) => {
      const dot = new paper.Path.Circle(toScreen(q), i === 0 ? 5 : 3);
      dot.fillColor = new paper.Color(i === 0 ? "#059669" : "#6b7280");
    });
  }
  if (trimPreview) {
    const g = toPaperPath(trimPreview);
    g.strokeColor = new paper.Color("#f97316");
    g.strokeWidth = 4;
    g.opacity = 0.9;
  }
  if (preview) {
    const sh = shapeFor(preview.tool, preview.a, preview.b);
    if (sh) {
      const g = toPaperPath(transformPath(sh.path, translation(sh.at.x, sh.at.y)));
      g.strokeColor = new paper.Color("#6b7280");
      g.dashArray = [4, 4];
    }
  }
  if (marquee) {
    const mode = boxMode(marquee.a, marquee.b);
    const r = rectOf(marquee.a, marquee.b);
    const tl = bedToScreen(view, { x: r.minX, y: r.maxY }), br = bedToScreen(view, { x: r.maxX, y: r.minY });
    const box = new paper.Path.Rectangle(new paper.Point(tl.x, tl.y), new paper.Point(br.x, br.y));
    const colour = mode === "window" ? "#2563eb" : "#16a34a"; // blue = must enclose, green = may touch
    box.strokeColor = new paper.Color(colour);
    box.fillColor = new paper.Color(colour);
    box.fillColor.alpha = 0.08;
    if (mode === "crossing") box.dashArray = [5, 4];
  }
  if (measureLine) drawMeasure(measureLine.a, measureLine.b);
  if (snapMarker) drawSnapMarker(snapMarker.pt, snapMarker.kind);
  drawGizmo();
  drawRulers();
  paper.view.update();
  updatePositionFields();
}

function fit(): void {
  view = fitView(machine.bed.widthMm, machine.bed.heightMm, paper.view.viewSize.width, paper.view.viewSize.height);
  draw();
}

function edit(fn: () => void): void {
  doc.checkpoint();
  fn();
  draw();
}

// ---- toolbar ----
for (const p of profiles) select.add(new Option(p.name, p.id));
select.addEventListener("change", () => {
  machine = profiles.find((p) => p.id === select.value) ?? machine;
  fit();
});
function setTool(next: Tool): void {
  tool = next;
  penPoints = [];
  penCursor = null;
  trimPreview = null;
  snapMarker = null;
  if (tool !== "measure") measureLine = null;
  canvas.style.cursor = tool === "trim" || tool === "measure" || tool === "text" || tool === "pen" ? "crosshair" : "";
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
  draw();
}
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) =>
  btn.addEventListener("click", () => setTool(btn.dataset.tool as Tool)),
);
const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener("click", fn);
on("score", () => selected.size && edit(() => doc.setLayer([...selected], "score")));
on("cut", () => selected.size && edit(() => doc.setLayer([...selected], "cut")));
on("del", () => deleteSelected());
const gimbalBtn = document.getElementById("gimbal") as HTMLButtonElement;
function setGimbal(on: boolean): void {
  showGimbal = on;
  gizmoHover = null;
  gimbalBtn.classList.toggle("on", on);
  draw();
}
on("gimbal", () => setGimbal(!showGimbal));
on("b-union", () => booleanSelected("union"));
on("b-intersect", () => booleanSelected("intersect"));
on("b-subtract", () => booleanSelected("subtract"));
on("group", () => groupSelected());
on("ungroup", () => ungroupSelected());
(document.getElementById("grid") as HTMLInputElement).addEventListener("change", (e) => {
  showGrid = (e.target as HTMLInputElement).checked;
  draw();
});
on("undo", () => { if (doc.undo()) { selected.clear(); draw(); } });
on("redo", () => { if (doc.redo()) { selected.clear(); draw(); } });
on("exp-dxf", () => download("kerf-design.dxf", toDXF(doc.state.objects), "application/dxf"));
on("exp-svg", () => download("kerf-design.svg", toSVG(doc.state.objects), "image/svg+xml"));

const fileInput = document.getElementById("file") as HTMLInputElement;
on("imp", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f) importDXF(await f.text(), f.name);
});

function importDXF(text: string, name: string): void {
  const r = parseDXF(text);
  if (!r.shapes.length) { alert(`No importable shapes in ${name}.`); return; }
  const k = mmPerUnit(r.insunits) ?? DEFAULT_MM_PER_UNIT; // no units in file: assume cm (Onshape default)
  const paths = r.shapes.map((s) => scalePath(s.path, k));
  const min = designMin(paths); // bounding box bottom-left -> (0,0)
  edit(() => {
    selected = new Set(r.shapes.map((s, i) => doc.add(paths[i]!, translation(-min.x, -min.y), s.layer).id));
  });
  const skipped = Object.entries(r.skipped).map(([t, n]) => `${n} ${t}`).join(", ");
  if (skipped) alert(`Imported ${r.shapes.length} shapes. Skipped unsupported: ${skipped}.`);
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message in the footer that clears itself. */
function notify(msg: string): void {
  const el = document.getElementById("notice")!;
  el.textContent = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.textContent = ""; }, 5000);
}

/**
 * Union / intersect / subtract the selection. A group (or text) counts as one compound shape, so a donut stays a donut.
 * Subtract removes every later-drawn shape from the earliest-drawn one. Results are baked paths in one group.
 */
function booleanSelected(op: BoolOp): void {
  const groups = new Map<string, DocObject[]>();
  for (const o of doc.state.objects.filter((x) => selected.has(x.id))) {
    const key = o.group !== undefined ? `g${o.group}` : `o${o.id}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const operands = [...groups.values()].sort((a, b) => Math.min(...a.map((o) => o.id)) - Math.min(...b.map((o) => o.id)));
  const result = booleanOp(op, operands.map((list) => list.map((o) => transformPath(o.path, o.matrix))));
  if (result.error) { notify(result.error); return; }
  const layer = operands[0]![0]!.layer;
  const ids = [...selected];
  edit(() => {
    doc.convertText(ids); // text is baked into the result
    doc.remove(ids);
    const group = result.paths.length > 1 ? doc.state.nextGroup++ : undefined;
    selected = new Set(result.paths.map((p) => { const o = doc.add(p, IDENTITY, layer); if (group !== undefined) o.group = group; return o.id; }));
  });
}

function groupSelected(): void {
  if (doc.expand(selected).length < 2) return;
  edit(() => { doc.group([...selected]); selected = new Set(doc.expand(selected)); });
}

function ungroupSelected(): void {
  if (!doc.state.objects.some((o) => selected.has(o.id) && o.group !== undefined)) return;
  edit(() => doc.ungroup([...selected]));
}

function deleteSelected(): void {
  if (selected.size) edit(() => { doc.remove([...selected]); selected.clear(); });
}

function download(name: string, text: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const typingInField = (e: KeyboardEvent) =>
  e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement ||
  (e.target instanceof HTMLInputElement && e.target.type !== "radio" && e.target.type !== "checkbox");

function setSpace(down: boolean): void {
  spaceDown = down;
  canvas.style.cursor = panning ? "grabbing" : down ? "grab" : tool === "trim" ? "crosshair" : "";
}

// Hold Space and drag with the left button to pan. Space must not click a focused toolbar button.
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !typingInField(e)) { e.preventDefault(); setSpace(true); return; }
}, true);
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !typingInField(e)) { e.preventDefault(); setSpace(false); }
}, true);
window.addEventListener("blur", () => { panning = null; setSpace(false); });

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && e.target.type !== "radio")) return; // typing in a field
  if (tool === "pen" && penPoints.length && e.key === "Enter") { e.preventDefault(); penFinish(false); }
  else if (tool === "pen" && penPoints.length && e.key === "Escape") penCancel();
  else if (tool === "pen" && penPoints.length && (e.key === "Backspace" || e.key === "Delete")) { penPoints.pop(); draw(); }
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if (e.key.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) setGimbal(!showGimbal);
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? doc.redo() : doc.undo()) && (selected.clear(), draw()); }
});

// ---- text ----
const textPanel = document.getElementById("textprops") as HTMLElement;
const tContent = document.getElementById("t-content") as HTMLInputElement;
const tFont = document.getElementById("t-font") as HTMLSelectElement;
const tSize = document.getElementById("t-size") as HTMLInputElement;
const tFile = document.getElementById("t-file") as HTMLInputElement;
let defaultFont = DEFAULT_FONT;
let defaultSize = 10; // mm
let textEditing = false; // one undo step per editing session, not per keystroke

function fillFontSelect(select?: string): void {
  tFont.replaceChildren();
  const groups: [string, boolean][] = [["Outline fonts", false], ["Single-line fonts (for Score)", true]];
  for (const [label, single] of groups) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const f of listFonts().filter((x) => (x.kind === "single") === single)) og.append(new Option(f.label, f.id));
    if (og.children.length) tFont.append(og);
  }
  if (select) tFont.value = select;
}

/** The text object a selection is exactly one of, if any. */
function selectedTextIds(): number[] {
  return [...new Set(doc.state.objects.filter((o) => selected.has(o.id) && o.textId !== undefined).map((o) => o.textId!))];
}

function refreshTextPanel(): void {
  const ids = selectedTextIds();
  textPanel.hidden = ids.length === 0 && tool !== "text";
  const one = ids.length === 1 ? doc.state.texts[ids[0]!] : undefined;
  for (const el of [tContent, tFont, tSize]) el.disabled = !one;
  if (!one) return;
  if (document.activeElement !== tContent) tContent.value = one.content;
  if (document.activeElement !== tFont) tFont.value = one.font;
  if (document.activeElement !== tSize) tSize.value = String(one.sizeMm);
}

function readTextSpec(): TextSpec | null {
  const spec = { content: tContent.value, font: tFont.value, sizeMm: parseFloat(tSize.value) };
  if (!spec.content.trim() || !(spec.sizeMm > 0)) return null; // ignore half-typed values
  return textToPaths(spec).length ? spec : null;
}

function applyText(): void {
  const ids = selectedTextIds();
  const spec = readTextSpec();
  if (ids.length !== 1 || !spec) return;
  if (!textEditing) { doc.checkpoint(); textEditing = true; }
  const kindChanged = getFont(doc.state.texts[ids[0]!]!.font)?.kind !== getFont(spec.font)?.kind;
  const newIds = doc.retext(ids[0]!, spec, textToPaths(spec));
  // Single-line fonts are for scoring and outline fonts for cutting: follow the font when its kind changes.
  if (kindChanged) doc.setLayer(newIds, getFont(spec.font)?.kind === "single" ? "score" : "cut");
  selected = new Set(newIds);
  defaultFont = spec.font;
  defaultSize = spec.sizeMm;
  draw();
}
for (const el of [tContent, tSize]) el.addEventListener("input", applyText);
tFont.addEventListener("change", applyText);
for (const el of [tContent, tSize, tFont]) el.addEventListener("blur", () => { textEditing = false; });

on("t-convert", () => { if (selectedTextIds().length) edit(() => doc.convertText(selected)); });
on("t-load", () => tFile.click());
tFile.addEventListener("change", async () => {
  const f = tFile.files?.[0];
  tFile.value = "";
  if (!f) return;
  try {
    const id = `user-${Date.now()}`;
    registerOutlineFont(id, f.name.replace(/\.[^.]+$/, ""), await f.arrayBuffer());
    fillFontSelect(id);
    if (selectedTextIds().length === 1) applyText();
    else defaultFont = id;
  } catch (err) {
    alert(`Could not read that font file: ${err instanceof Error ? err.message : err}`);
  }
});

/** Add a new text object at the clicked point, then hand over to the Select tool and the text box. */
function placeText(p: Point): void {
  const spec: TextSpec = { content: "Text", font: getFont(defaultFont) ? defaultFont : DEFAULT_FONT, sizeMm: defaultSize };
  const paths = textToPaths(spec);
  if (!paths.length) return; // fonts still loading
  const layer: LayerType = getFont(spec.font)?.kind === "single" ? "score" : "cut";
  edit(() => { selected = new Set(doc.textMembers(doc.addText(spec, paths, translation(p.x, p.y), layer))); });
  setTool("select");
  refreshTextPanel(); // the panel must be enabled before it can take focus
  tContent.focus();
  tContent.select();
}

// ---- pen (click-to-draw polygon) ----
function penFinish(closed: boolean): void {
  const path = polylinePath(penPoints, closed);
  penPoints = [];
  penCursor = null;
  if (path) edit(() => { selected = new Set([doc.add(path, IDENTITY).id]); });
  else draw();
}
const penCancel = () => { if (penPoints.length) { penPoints = []; penCursor = null; draw(); } };

/** A click with the Pen tool: add a vertex, or close the shape when the first vertex is clicked again. */
function penClick(p: Point): void {
  const first = penPoints[0];
  if (first && penPoints.length >= 3) {
    const a = bedToScreen(view, first), b = bedToScreen(view, p);
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 10) { penFinish(true); return; } // clicked the first point again: close
  }
  const last = penPoints[penPoints.length - 1];
  if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) return; // the second click of a double-click
  penPoints.push(p);
  draw();
}

// ---- snapping ----
(document.getElementById("snap") as HTMLInputElement).addEventListener("change", (e) => {
  snapOn = (e.target as HTMLInputElement).checked;
  if (!snapOn) snapMarker = null;
  draw();
});
const snapTolMm = () => 10 / view.scale; // a 10 px snap radius
const snapActive = (e: MouseEvent) => snapOn && !e.altKey; // hold Alt/Option to disable

/** Snap a point (drawing, measuring). Updates the on-screen marker. */
function snapPt(p: Point, e: MouseEvent): Point {
  if (!snapActive(e)) { snapMarker = null; return p; }
  const s = snapTo(doc.state.objects, p, snapTolMm(), { grid: true });
  snapMarker = s ? { pt: s.point, kind: s.kind } : null;
  return s?.point ?? p;
}

/** Adjust a drag delta so the selection's nearest bounding-box point lands on a snap target. */
function snapMove(delta: Point, e: MouseEvent): Point {
  snapMarker = null;
  if (!snapActive(e) || !moveBounds) return delta;
  const b = moveBounds;
  type Best = { adj: Point; dist: number; pt: Point; kind: SnapKind };
  // Object snaps (corners, midpoints, centres, intersections) beat the grid: try them across all 9 points first.
  for (const grid of [false, true]) {
    let best: Best | null = null;
    for (const x of [b.minX, (b.minX + b.maxX) / 2, b.maxX])
      for (const y of [b.minY, (b.minY + b.maxY) / 2, b.maxY]) {
        const q = { x: x + delta.x, y: y + delta.y };
        const s = snapTo(doc.state.objects, q, snapTolMm(), { grid, exclude: selected });
        if (s && (!best || s.dist < best.dist)) best = { adj: { x: s.point.x - q.x, y: s.point.y - q.y }, dist: s.dist, pt: s.point, kind: s.kind };
      }
    if (best) {
      snapMarker = { pt: best.pt, kind: best.kind };
      return { x: delta.x + best.adj.x, y: delta.y + best.adj.y };
    }
  }
  return delta;
}

const HANDLE_CURSOR: Record<Handle, string> = { move: "move", "move-x": "ew-resize", "move-y": "ns-resize", "scale-x": "ew-resize", "scale-y": "ns-resize", scale: "nesw-resize", rotate: "grab" };

/** The gimbal handle under a mouse event, if the gimbal is showing. */
function gizmoAt(e: MouseEvent): { handle: Handle; pivot: Point } | null {
  if (!showGimbal || tool !== "select" || !selected.size) return null;
  const b = selectionBounds(doc.state.objects, selected);
  if (!b) return null;
  const pivot = anchorPoint(b, anchor);
  const r = canvas.getBoundingClientRect();
  const handle = hitGizmo(bedToScreen(view, pivot), { x: e.clientX - r.left, y: e.clientY - r.top });
  return handle ? { handle, pivot } : null;
}

function startGizmoDrag(hit: { handle: Handle; pivot: Point }, e: MouseEvent): void {
  moveBounds = selectionBounds(doc.state.objects, selected); // for snapping axis moves
  gizmoDrag = {
    handle: hit.handle, pivot: hit.pivot, start: bedPt(e), started: false, label: "",
    mats: new Map(doc.state.objects.filter((o) => selected.has(o.id)).map((o) => [o.id, [...o.matrix] as Matrix])),
  };
  canvas.style.cursor = HANDLE_CURSOR[hit.handle];
}

function updateGizmoDrag(e: MouseEvent): void {
  const d = gizmoDrag!;
  const cur = bedPt(e);
  let m = gizmoMatrix(d.handle, d.pivot, d.start, cur, { step: e.shiftKey });
  if (!m) return;
  snapMarker = null;
  if (d.handle === "move" || d.handle === "move-x" || d.handle === "move-y") {
    const s = snapMove({ x: m[4], y: m[5] }, e); // object snaps, then drop whatever the axis forbids
    m = [1, 0, 0, 1, d.handle === "move-y" ? 0 : s.x, d.handle === "move-x" ? 0 : s.y];
    d.label = `dx ${m[4].toFixed(2)}  dy ${m[5].toFixed(2)} mm`;
  } else if (d.handle === "rotate") d.label = `${gizmoAngle(d.pivot, d.start, cur, { step: e.shiftKey }).toFixed(1)}\u00b0`;
  else if (d.handle === "scale-x") d.label = `${(m[0] * 100).toFixed(0)}%`;
  else if (d.handle === "scale-y") d.label = `${(m[3] * 100).toFixed(0)}%`;
  else d.label = `${(m[0] * 100).toFixed(0)}%`;
  if (!d.started) { doc.checkpoint(); d.started = true; }
  for (const [id, start] of d.mats) doc.get(id)!.matrix = multiply(m, start);
  draw();
}

const isDrawTool = () => tool === "rect" || tool === "circle" || tool === "line" || tool === "polygon" || tool === "measure";

// ---- pointer ----
const bedPt = (e: MouseEvent): Point => {
  const r = canvas.getBoundingClientRect();
  return screenToBed(view, { x: e.clientX - r.left, y: e.clientY - r.top });
};
let dragStart: Point | null = null;
let dragLast: Point | null = null;
let moved = false;

const trimTolMm = () => 8 / view.scale; // an 8 px pick radius

/** Replace the clicked object with whatever is left after trimming. Placement is baked into the new paths. */
function doTrim(p: Point): void {
  const plan = planTrim(doc.state.objects, p, trimTolMm());
  if (!plan) return;
  const old = doc.get(plan.objectId)!;
  edit(() => {
    doc.convertText([old.id]); // trimmed contours can no longer be regenerated from the text
    doc.remove([old.id]);
    selected.delete(old.id);
    for (const path of plan.keep) { const o = doc.add(path, IDENTITY, old.layer); o.group = old.group; }
  });
}

/** Outlines beat interiors; among interiors the smallest shape wins, so a shape inside another stays selectable. */
function pickObject(pt: paper.Point): number | undefined {
  const hits = paper.project.hitTestAll(pt, { stroke: true, fill: true, tolerance: 6 }).filter((h) => h.item.data?.id !== undefined);
  const stroke = hits.find((h) => h.type === "stroke");
  if (stroke) return stroke.item.data.id as number;
  const area = (h: paper.HitResult) => h.item.bounds.width * h.item.bounds.height;
  const fill = hits.filter((h) => h.type === "fill").sort((a, b) => area(a) - area(b))[0];
  return fill?.item.data.id as number | undefined;
}

canvas.addEventListener("mousedown", (e) => {
  if (spaceDown && e.button === 0) {
    panning = { x: e.clientX, y: e.clientY };
    setSpace(true);
    e.preventDefault();
    return;
  }
  const rr = canvas.getBoundingClientRect();
  if (e.clientX - rr.left < RULER || e.clientY - rr.top < RULER) return; // clicks on the rulers do nothing
  const gh = gizmoAt(e);
  if (gh) { e.preventDefault(); startGizmoDrag(gh, e); return; }
  if (tool === "pen") { if (e.button === 0) penClick(snapPt(bedPt(e), e)); return; }
  if (tool === "text") { e.preventDefault(); placeText(snapPt(bedPt(e), e)); snapMarker = null; return; } // preventDefault: keep focus on the text box
  const p = isDrawTool() ? snapPt(bedPt(e), e) : bedPt(e);
  dragStart = dragLast = p;
  moved = false;
  if (tool === "measure") { measureLine = { a: p, b: p }; draw(); return; }
  if (tool === "trim") { doTrim(p); trimPreview = null; draw(); return; }
  if (tool === "select") {
    const r = canvas.getBoundingClientRect();
    const id = pickObject(new paper.Point(e.clientX - r.left, e.clientY - r.top));
    if (id === undefined) {
      if (!e.shiftKey) selected.clear();
      marquee = { a: p, b: p, base: new Set(selected) };
    }
    else if (e.shiftKey) { const m = doc.expand([id]); const was = selected.has(id); for (const i of m) was ? selected.delete(i) : selected.add(i); }
    else if (!selected.has(id)) selected = new Set(doc.expand([id]));
    draw();
  }
});

window.addEventListener("mousemove", (e) => {
  if (gizmoDrag) { updateGizmoDrag(e); return; }
  if (!panning) return;
  view = panBy(view, e.clientX - panning.x, e.clientY - panning.y);
  panning = { x: e.clientX, y: e.clientY };
  draw();
});

canvas.addEventListener("mousemove", (e) => {
  if (panning || gizmoDrag) return;
  if (showGimbal && tool === "select" && !dragStart) {
    const h = gizmoAt(e)?.handle ?? null;
    if (h !== gizmoHover) { gizmoHover = h; canvas.style.cursor = h ? HANDLE_CURSOR[h] : ""; draw(); }
  }
  const raw = bedPt(e);
  cursorEl.textContent = `X ${raw.x.toFixed(1)}  Y ${raw.y.toFixed(1)} mm`;
  if (tool === "pen") { penCursor = snapPt(raw, e); draw(); return; }
  const p = isDrawTool() ? snapPt(raw, e) : raw;
  if (isDrawTool() && !dragStart) draw(); // show the snap marker while hovering
  if (tool === "measure") {
    if (dragStart && measureLine) { measureLine = { a: measureLine.a, b: p }; draw(); }
    return;
  }
  if (tool === "trim") {
    const next = planTrim(doc.state.objects, p, trimTolMm())?.removed ?? null;
    if ((next === null) !== (trimPreview === null) || next) { trimPreview = next; draw(); }
    return;
  }
  if (!dragStart || !dragLast) return;
  if (marquee) {
    marquee.b = p;
    selected = new Set([...marquee.base, ...doc.expand(boxSelect(doc.state.objects, marquee.a, p))]);
  } else if (tool === "select" && selected.size) {
    if (!moved) { doc.checkpoint(); moved = true; moveBounds = selectionBounds(doc.state.objects, selected); moveApplied = { x: 0, y: 0 }; }
    const want = snapMove({ x: p.x - dragStart.x, y: p.y - dragStart.y }, e);
    const step = { x: want.x - moveApplied.x, y: want.y - moveApplied.y };
    for (const id of selected) doc.transform(id, translation(step.x, step.y));
    moveApplied = want;
    dragLast = p;
  } else if (tool !== "select") {
    preview = { tool, a: dragStart, b: p };
  }
  draw();
});

window.addEventListener("mouseup", (e) => {
  if (panning) { panning = null; setSpace(spaceDown); return; }
  if (gizmoDrag) { gizmoDrag = null; moveBounds = null; snapMarker = null; gizmoHover = null; canvas.style.cursor = ""; draw(); return; }
  if (dragStart && tool !== "select") {
    const sh = shapeFor(tool, dragStart, snapPt(bedPt(e), e));
    if (sh) edit(() => { selected = new Set([doc.add(sh.path, translation(sh.at.x, sh.at.y) ?? IDENTITY).id]); });
  }
  marquee = null;
  moveBounds = null;
  snapMarker = null;
  dragStart = dragLast = null;
  preview = null;
  draw();
});

canvas.addEventListener("dblclick", () => { if (tool === "pen" && penPoints.length) penFinish(penPoints.length >= 3); });

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  view = zoomAt(view, { x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  draw();
}, { passive: false });

paper.view.onResize = fit;
fit();
fillFontSelect();
loadBundledFonts(async (file) => (await fetch(`/fonts/${file}`)).arrayBuffer())
  .then(() => fillFontSelect(defaultFont))
  .catch((err) => console.error("Could not load bundled fonts", err));

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
