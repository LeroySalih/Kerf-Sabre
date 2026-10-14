import paper from "paper";
import "./style.css";
import { bedToScreen, fitView, panBy, screenToBed, zoomAt, type Point, type View } from "./coords";
import { Doc, type ClipData, type DocObject, type LayerType } from "./doc";
import { DEFAULT_MM_PER_UNIT, designMin, mmPerUnit, parseDXF, scalePath } from "./dxf-import";
import { toDXF, toSVG } from "./export";
import { IDENTITY, arcMid, circle, ellipse, line, star, multiply, polylinePath, rectangle, regularPolygon, translation, transformPath, type Matrix, type Path } from "./geometry";
import { GIZMO, gizmoAngle, gizmoMatrix, gizmoPoints, hitGizmo, type Handle } from "./gizmo";
import { DEFAULT_ANCHOR, anchorPoint, deltaToAnchor, rotateAboutAnchor, scaleAboutAnchor, scaleBy, selectionBounds, type Anchor, type Axis } from "./anchor";
import { boundsOf, type Bounds } from "./geometry";
import { distToPrim, explicit as explicitPath, planTrim, primOf as primsFor } from "./trim";
import { circularMatrices, linearOffsets, mirrorMatrix, validateCircular, validateLinear, type CircularParams, type LinearParams } from "./arrays";
import { alignDeltas, distributeDeltas, unionBounds, type AlignKind, type Unit } from "./align";
import { booleanOp, type BoolOp } from "./boolean";
import { parseClip, serializeClip } from "./clipboard";
import { openDialog } from "./dialog";
import { boxNet, validateBoxNet, type BoxNetParams } from "./boxnet";
import { fingerBox, validateFingerBox, type FingerBoxParams } from "./fingerbox";
import { kerfTest, testGrid, validateKerfTest, validateTestGrid, type TestGridParams, type TestItem } from "./testgrid";
import { canSubmit, outOfBounds } from "./bounds";
import { snapTo, type SnapKind } from "./snap";
import { DEFAULT_FONT, getFont, listFonts, loadBundledFonts, registerOutlineFont, textToPaths, type TextSpec } from "./text";
import { PLACEHOLDER_PRESETS, presetStore, findPreset, formatOperation, presetLabel, resolvePreset, type Operation } from "./presets";
import { selectionSummary } from "./status";
import { formatMeasurement, measure, rulerTicks } from "./ruler";
import { boxMode, boxSelect, rectOf } from "./select";
import { filletAll, filletVertices, nearestCorner, roundedRectangle, type CornerMode } from "./fillet";
import { mountIcons } from "./icons";
import { autoTabFractions, nearestFraction, tabPieces, toggleTab } from "./tabs";
import { closePath, deleteNode, explodePath, insertNode, joinPaths, moveNode, nodePoints } from "./repair";
import { loadMachineProfiles, type MachineProfile } from "./machine";
import { initServerUi } from "./serverui";
import { cleanPoints, splinePath } from "./spline";
import { offsetPath, type OffsetCorner, type OffsetSide } from "./offset";
import { boxDimensions, dimGeometry, dimLabel, linearAxis, pickDimension, radialFromPath, type DimAxis, type Dimension, type LinearDim } from "./dimensions";

mountIcons();
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const select = document.getElementById("machine") as HTMLSelectElement;
const cursorEl = document.getElementById("cursor") as HTMLElement;

const profiles = loadMachineProfiles();
let machine: MachineProfile = profiles[0]!;
let view: View;
const doc = new Doc();
let selected = new Set<number>();
type Tool = "select" | "nodes" | "tab" | "rect" | "rrect" | "ellipse" | "circle" | "line" | "polygon" | "star" | "pen" | "trim" | "radius" | "measure" | "text" | "dim" | "dimr" | "spline" | "offset";
let tool: Tool = "select";
/** The Select and Offset tools both pick and move shapes; Offset also shows a preview of the result. */
const selectish = (): boolean => tool === "select" || tool === "offset";
let showGrid = true;
let spaceDown = false;
let nodeSel: { id: number; index: number } | null = null; // the node picked in the Nodes tool
let nodeDrag: { id: number; index: number; base: Path; started: boolean } | null = null;
let activeLayer: LayerType = "cut"; // layer for newly drawn shapes; the chips in the bottom bar change it
let penPoints: Point[] = []; // vertices placed so far by the Pen tool (bed mm)
let splinePts: Point[] = []; // points placed so far by the Spline tool (bed mm)
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
  if (t === "rrect" && w > 0.1 && h > 0.1) return { path: roundedRectangle(w, h, Math.max(0, parseFloat((document.getElementById("rrad") as HTMLInputElement).value) || 0)), at: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) } };
  if (t === "ellipse" && w > 0.1 && h > 0.1) return { path: ellipse(w / 2, h / 2), at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  if (t === "star") {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const pts = Math.min(32, Math.max(3, Math.round(parseFloat((document.getElementById("star-points") as HTMLInputElement).value) || 5)));
    const inner = Math.min(95, Math.max(5, parseFloat((document.getElementById("star-inner") as HTMLInputElement).value) || 40)) / 100;
    if (r > 0.1) return { path: star(pts, r, r * inner, Math.atan2(b.y - a.y, b.x - a.x)), at: a };
  }
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
  refreshLayerUI();
  refreshActions();
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

/** Node handles of the single selected shape (Nodes tool). */
function drawNodes(): void {
  const o = nodeTarget();
  if (!o) return;
  nodePoints(transformPath(o.path, o.matrix)).forEach((q, i) => {
    const c = toScreen(q);
    const h = new paper.Path.Rectangle(new paper.Point(c.x - 4.5, c.y - 4.5), new paper.Size(9, 9));
    const picked = nodeSel?.id === o.id && nodeSel.index === i;
    h.fillColor = new paper.Color(picked ? "#f97316" : "#ffffff");
    h.strokeColor = new paper.Color(picked ? "#c2410c" : "#2563eb");
    h.strokeWidth = 1.5;
  });
}

function drawSnapMarker(pt: Point, kind: SnapKind): void {
  const c = toScreen(pt);
  const box = new paper.Path.Rectangle(new paper.Point(c.x - 6, c.y - 6), new paper.Size(12, 12));
  box.strokeColor = new paper.Color("#059669");
  box.strokeWidth = 2;
  new paper.PointText({ point: c.add(new paper.Point(10, -8)), content: kind, fontSize: 11, fontWeight: "bold", fillColor: new paper.Color("#047857") });
}

// ---- offset: parallel copies of the selected shapes and lines ----
const offDist = document.getElementById("off-dist") as HTMLInputElement;
const offSide = document.getElementById("off-side") as HTMLSelectElement;
const offCorner = document.getElementById("off-corner") as HTMLSelectElement;
const offKeep = document.getElementById("off-keep") as HTMLInputElement;
let offsetMemo: { key: string; paths: { src: DocObject; out: Path[] }[] } | null = null;

/** The offsets of the selection as they would be made now. Remembered until the selection, the shapes or the settings change. */
function offsetResults(): { src: DocObject; out: Path[] }[] {
  const distance = parseFloat(offDist.value);
  if (!(distance > 0) || distance > 1000) return [];
  const objs = doc.state.objects.filter((o) => selected.has(o.id));
  const opts = { distance, side: offSide.value as OffsetSide, corner: offCorner.value as OffsetCorner };
  const key = JSON.stringify([opts, objs.map((o) => [o.id, o.path, o.matrix])]);
  if (offsetMemo?.key === key) return offsetMemo.paths;
  const paths = objs.map((o) => ({ src: o, out: offsetPath(transformPath(o.path, o.matrix), opts) }));
  offsetMemo = { key, paths };
  return paths;
}

function drawOffsetPreview(): void {
  if (tool !== "offset" || !selected.size) return;
  for (const { out } of offsetResults()) for (const p of out) {
    const g = toPaperPath(p);
    g.strokeColor = new paper.Color("#7c3aed");
    g.strokeWidth = 1.5;
    g.dashArray = [5, 3];
  }
}

function applyOffset(): void {
  if (!selected.size) { notify("Select the shapes or lines to offset first."); return; }
  const distance = parseFloat(offDist.value);
  if (!(distance > 0) || distance > 1000) { notify("Enter a distance greater than 0."); return; }
  const results = offsetResults().filter((r) => r.out.length);
  if (!results.length) { notify("Nothing to draw: the offset is larger than the shape, or the shape can't be offset."); return; }
  const keep = offKeep.checked;
  edit(() => {
    const made: number[] = [];
    if (!keep) { doc.convertText(results.map((r) => r.src.id)); doc.remove(results.map((r) => r.src.id)); }
    for (const { src, out } of results) for (const p of out) made.push(doc.add(p, IDENTITY, src.layer).id);
    selected = new Set(made);
  });
  offsetMemo = null;
  notify(`Made ${results.reduce((n, r) => n + r.out.length, 0)} offset ${results.reduce((n, r) => n + r.out.length, 0) === 1 ? "shape" : "shapes"}.`);
}
for (const el of [offDist, offSide, offCorner]) el.addEventListener("input", () => draw());
document.getElementById("off-apply")!.addEventListener("click", applyOffset);
offDist.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyOffset(); } });

// ---- dimensions: annotations only (never cut, exported or sent to the Cutter) ----
const DIM_COLOUR = "#0f766e";
let showDims = true;
let dimDraft: { a: Point; b?: Point } | null = null; // the Dimension tool: first point, then second point, then the offset
let dimCursor: Point | null = null;
let selectedDims = new Set<string>();
const dimAxisSel = document.getElementById("dim-axis") as HTMLSelectElement;
const dimKindSel = document.getElementById("dim-kind") as HTMLSelectElement;

function chooseAxis(a: Point, b: Point): DimAxis {
  const v = dimAxisSel.value;
  if (v !== "auto") return v as DimAxis;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  return dx >= 2 * dy ? "horizontal" : dy >= 2 * dx ? "vertical" : "aligned";
}

/** The offset that puts the dimension line through `p`. */
function offsetThrough(axis: DimAxis, a: Point, b: Point, p: Point): number {
  const u = linearAxis({ id: "", kind: "linear", axis, a, b, offsetMm: 0 });
  const n = { x: -u.y, y: u.x };
  return p.x * n.x + p.y * n.y - Math.max(a.x * n.x + a.y * n.y, b.x * n.x + b.y * n.y);
}

/** What the Dimension tool would add right now, drawn faintly. */
function dimGhost(): LinearDim | null {
  if (tool !== "dim" || !dimDraft || !dimCursor) return null;
  const axis = chooseAxis(dimDraft.a, dimDraft.b ?? dimCursor);
  if (!dimDraft.b) return { id: "ghost", kind: "linear", axis, a: dimDraft.a, b: dimCursor, offsetMm: 0 };
  return { id: "ghost", kind: "linear", axis, a: dimDraft.a, b: dimDraft.b, offsetMm: offsetThrough(axis, dimDraft.a, dimDraft.b, dimCursor) };
}

function drawDimension(d: Dimension, isSelected: boolean, ghost: boolean): void {
  const g = dimGeometry(d);
  const colour = new paper.Color(isSelected ? "#e11d48" : DIM_COLOUR);
  const width = isSelected ? 2 : 1;
  for (const [p, q] of g.lines) {
    const l = new paper.Path.Line(toScreen(p), toScreen(q));
    l.strokeColor = colour;
    l.strokeWidth = width;
    if (ghost) l.dashArray = [4, 3];
  }
  for (const { tip, dir } of g.arrows) {
    const t = toScreen(tip);
    const u = new paper.Point(dir.x, -dir.y); // screen Y is down
    const base = t.subtract(u.multiply(9));
    const side = new paper.Point(-u.y, u.x).multiply(3.2);
    const head = new paper.Path([t, base.add(side), base.subtract(side)]);
    head.closed = true;
    head.fillColor = colour;
  }
  const at = toScreen(g.labelAt).add(new paper.Point(0, d.kind === "linear" ? -9 : 4));
  const label = new paper.PointText({ point: at, content: dimLabel(d), fontSize: 12, fontWeight: "bold", justification: "center", fillColor: colour });
  const bg = new paper.Path.Rectangle(label.bounds.expand(3));
  bg.fillColor = new paper.Color(1, 1, 1, 0.85);
  label.insertAbove(bg);
}

function dimClick(p: Point): void {
  if (!dimDraft) { dimDraft = { a: p }; dimCursor = p; draw(); return; }
  if (!dimDraft.b) {
    if (Math.hypot(p.x - dimDraft.a.x, p.y - dimDraft.a.y) < 0.01) return; // same point twice
    dimDraft.b = p;
    draw();
    return;
  }
  const { a, b } = dimDraft;
  const axis = chooseAxis(a, b);
  edit(() => { doc.addDimensions([{ id: doc.newDimId(), kind: "linear", axis, a, b, offsetMm: offsetThrough(axis, a, b, p) }]); });
  dimDraft = null;
}

function dimRadialClick(e: MouseEvent): void {
  const r = canvas.getBoundingClientRect();
  const id = pickObject(new paper.Point(e.clientX - r.left, e.clientY - r.top));
  const o = id === undefined ? undefined : doc.get(id);
  const dim = o ? radialFromPath(transformPath(o.path, o.matrix), bedPt(e), 12 / view.scale, dimKindSel.value === "diameter", "") : null;
  if (!dim) { notify("Click on a circle or an arc."); return; }
  edit(() => { doc.addDimensions([{ ...dim, id: doc.newDimId() }]); });
}

function dimensionSelection(): void {
  const objs = doc.state.objects.filter((o) => selected.has(o.id));
  if (!objs.length) return;
  const bs = objs.map((o) => boundsOf(transformPath(o.path, o.matrix)));
  const box = { minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)), maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)) };
  edit(() => { doc.addDimensions(boxDimensions(box, () => doc.newDimId())); });
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
    if (o.tabs && o.layer === "cut" && o.path.closed) {
      for (const piece of tabPieces(transformPath(o.path, o.matrix), o.tabs)) { // a tab is a gap in the cut: paint over the line
        const gap = toPaperPath(piece);
        gap.strokeColor = new paper.Color("#ffffff");
        gap.strokeWidth = 6;
        for (const end of [piece.start, piece.segs[piece.segs.length - 1]!.to]) {
          const dot = new paper.Path.Circle(toScreen(end), 2.2);
          dot.fillColor = new paper.Color("#f97316");
        }
      }
    }
  }
  for (const g of new Set(doc.state.objects.filter((o) => selected.has(o.id) && o.group !== undefined).map((o) => o.group))) {
    const bs = doc.state.objects.filter((o) => o.group === g).map((o) => boundsOf(transformPath(o.path, o.matrix)));
    const tl = bedToScreen(view, { x: Math.min(...bs.map((b) => b.minX)), y: Math.max(...bs.map((b) => b.maxY)) });
    const br = bedToScreen(view, { x: Math.max(...bs.map((b) => b.maxX)), y: Math.min(...bs.map((b) => b.minY)) });
    const box = new paper.Path.Rectangle(new paper.Point(tl.x - 4, tl.y - 4), new paper.Point(br.x + 4, br.y + 4));
    box.strokeColor = new paper.Color("#2563eb");
    box.dashArray = [2, 3];
  }
  if (tool === "nodes") drawNodes();
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
  if (splinePts.length) {
    const pts = penCursor ? [...splinePts, penCursor] : splinePts;
    const curve = splinePath(pts, false);
    if (curve) {
      const g = toPaperPath(curve);
      g.strokeColor = new paper.Color("#6b7280");
      g.strokeWidth = 1.5;
      g.dashArray = [4, 4];
    }
    splinePts.forEach((q, i) => {
      const dot = new paper.Path.Circle(toScreen(q), i === 0 ? 5 : 3);
      dot.fillColor = new paper.Color(i === 0 ? "#059669" : "#2563eb");
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
  drawOffsetPreview();
  if (showDims) for (const d of doc.state.dimensions) drawDimension(d, selectedDims.has(d.id), false);
  const ghost = dimGhost();
  if (ghost) drawDimension(ghost, false, true);
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
  nodeSel = null;
  nodeDrag = null;
  refreshOptions();
  penPoints = [];
  splinePts = [];
  penCursor = null;
  dimDraft = null;
  trimPreview = null;
  snapMarker = null;
  if (tool !== "measure") measureLine = null;
  canvas.style.cursor = tool === "trim" || tool === "measure" || tool === "text" || tool === "pen" || tool === "radius" || tool === "nodes" || tool === "tab" || tool === "dim" || tool === "dimr" || tool === "spline" ? "crosshair" : "";
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
  draw();
}
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) =>
  btn.addEventListener("click", () => setTool(btn.dataset.tool as Tool)),
);
const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener("click", fn);
// Layer chips: choose the layer for new shapes, and move the selection onto it.
document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) =>
  b.addEventListener("click", () => {
    activeLayer = b.dataset.layer as LayerType;
    if (selected.size) edit(() => doc.setLayer([...selected], activeLayer));
    else refreshLayerUI();
  }),
);

/** Chips show the selection's layer (or the layer for new shapes); the table counts shapes per layer; material settings are locked. */
/** Show the Options sections that apply: the tool's own, plus Tabs whenever a selected shape has tabs. */
function refreshOptions(): void {
  const hasTabs = doc.state.objects.some((o) => selected.has(o.id) && o.tabs);
  const show: Record<string, boolean> = {
    "opt-polygon": tool === "polygon",
    "opt-radius": tool === "radius",
    "opt-rrect": tool === "rrect",
    "opt-star": tool === "star",
    "opt-tabs": tool === "tab" || hasTabs,
    "opt-dim": tool === "dim" || tool === "dimr",
    "opt-offset": tool === "offset",
  };
  for (const [id, on] of Object.entries(show)) (document.getElementById(id) as HTMLElement).hidden = !on;
  (document.getElementById("opt-none") as HTMLElement).hidden = Object.values(show).some(Boolean);
}

/** Disable toolbar actions that can't apply to the current selection. */
function refreshActions(): void {
  refreshOptions();
  const objs = doc.state.objects.filter((o) => selected.has(o.id));
  const units = new Set(objs.map((o) => (o.group !== undefined ? `g${o.group}` : `o${o.id}`))).size;
  const set = (id: string, enabled: boolean) => { (document.getElementById(id) as HTMLButtonElement).disabled = !enabled; };
  for (const id of ["b-union", "b-intersect", "b-subtract", "group"]) set(id, units >= 2);
  set("ungroup", objs.some((o) => o.group !== undefined));
  for (const id of ["flip-h", "flip-v", "round-all", "act-linear", "act-circular", "copy", "dup"]) set(id, objs.length >= 1);
  set("act-tabs", objs.some(tabbable));
  set("act-dim-auto", objs.length >= 1);
  set("del", objs.length >= 1 || selectedDims.size >= 1);
  set("act-join", objs.filter((o) => !o.path.closed).length >= 2);
  set("act-close", objs.some((o) => !o.path.closed));
  set("act-explode", objs.some((o) => o.path.segs.length >= 2 || (o.path.closed && o.path.segs.length >= 1)));
  for (const id of ["dist-h", "dist-v"]) set(id, units >= 3);
  document.querySelectorAll<HTMLButtonElement>("[data-align]").forEach((b) => { b.disabled = objs.length < 1; });
  set("paste", clipboard !== null);
}

function refreshLayerUI(): void {
  const layers = new Set(doc.state.objects.filter((o) => selected.has(o.id)).map((o) => o.layer));
  const shown: LayerType = layers.size === 1 ? [...layers][0]! : activeLayer;
  document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((b) => b.classList.toggle("on", b.dataset.layer === shown));

  const preset = findPreset(doc.state.materialId) ?? presetStore[0]!;
  const r = resolvePreset(preset, machine.id);
  const op = (o: Operation) => `${o.powerPct}% \u00b7 ${o.speedMmPerS} mm/s \u00b7 \u00d7${o.passes} \u00b7 air ${o.airAssist ? "on" : "off"}`;
  document.getElementById("mat-kerf")!.textContent = `Kerf ${r.kerfMm} mm`;
  document.getElementById("mat-cut")!.innerHTML = `<i class="sw cut"></i>Cut ${op(r.cut)}`;
  document.getElementById("mat-score")!.innerHTML = `<i class="sw score"></i>Score ${op(r.score)}`;
  document.getElementById("mat-flag")!.textContent = r.untested ? `Not tested on ${machine.name}: a teacher must run a test grid first` : "";
  (document.getElementById("material") as HTMLSelectElement).value = preset.id;

  const count = (l: LayerType) => doc.state.objects.filter((o) => o.layer === l).length;
  const row = (l: LayerType, label: string, o: Operation) =>
    `<tr><td><i class="sw ${l}"></i>${label}</td><td>${o.speedMmPerS}</td><td>${o.powerPct}%</td><td>${o.passes}</td><td>${o.airAssist ? "on" : "off"}</td><td>${count(l)}</td></tr>`;
  document.getElementById("layertable")!.innerHTML = row("cut", "Cut", r.cut) + row("score", "Score", r.score);
}

// Material: pupils pick one and the settings follow, locked. Presets are placeholders until the Server provides them.
const materialSel = document.getElementById("material") as HTMLSelectElement;
function fillMaterials(): void {
  materialSel.replaceChildren();
  for (const p of presetStore) materialSel.add(new Option(presetLabel(p), p.id));
  if (!findPreset(doc.state.materialId)) doc.state.materialId = presetStore[0]!.id;
}
fillMaterials();
materialSel.addEventListener("change", () => edit(() => { doc.state.materialId = materialSel.value; }));
on("del", () => deleteSelected());
const gimbalBtn = document.getElementById("gimbal") as HTMLButtonElement;
function setGimbal(on: boolean): void {
  showGimbal = on;
  gizmoHover = null;
  gimbalBtn.classList.toggle("on", on);
  draw();
}
on("gimbal", () => setGimbal(!showGimbal));
document.querySelectorAll<HTMLButtonElement>("[data-align]").forEach((b) => b.addEventListener("click", () => alignSelected(b.dataset.align as AlignKind)));
on("dist-h", () => distributeSelected("h"));
on("dist-v", () => distributeSelected("v"));
on("b-union", () => booleanSelected("union"));
on("act-dim-auto", dimensionSelection);
document.getElementById("show-dims")!.addEventListener("change", (ev) => { showDims = (ev.target as HTMLInputElement).checked; draw(); });
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
  // Onshape exports every edge as its own entity: chain the ones that meet into real shapes, per layer.
  const tol = joinTol();
  let merges = 0, closed = 0;
  const items: { path: Path; layer: LayerType }[] = [];
  for (const layer of ["cut", "score"] as LayerType[]) {
    const mine = paths.filter((_, i) => r.shapes[i]!.layer === layer);
    if (!mine.length) continue;
    const j = joinPaths(mine, tol);
    merges += j.merges; closed += j.newlyClosed;
    items.push(...j.paths.map((path) => ({ path, layer })));
  }
  edit(() => {
    selected = new Set(items.map((it) => doc.add(it.path, translation(-min.x, -min.y), it.layer).id));
  });
  const skipped = Object.entries(r.skipped).map(([t, n]) => `${n} ${t}`).join(", ");
  notify(`Imported ${r.shapes.length} entities as ${items.length} shapes${closed ? ` (${closed} closed)` : ""}${merges ? `, joining ends within ${tol} mm` : ""}.${skipped ? ` Skipped unsupported: ${skipped}.` : ""}`);
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

/** Selected shapes as align units: each group (or text) is one unit. */
function selectedUnits(): Unit[] {
  const byKey = new Map<string, number[]>();
  for (const o of doc.state.objects.filter((x) => selected.has(x.id))) {
    const key = o.group !== undefined ? `g${o.group}` : `o${o.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), o.id]);
  }
  return [...byKey.values()].map((ids) => ({ ids, bounds: selectionBounds(doc.state.objects, ids)! }));
}

function moveUnits(units: Unit[], deltas: { x: number; y: number }[]): void {
  if (deltas.every((d) => Math.abs(d.x) < 1e-9 && Math.abs(d.y) < 1e-9)) return; // already in place: no undo step
  edit(() => units.forEach((u, i) => { for (const id of u.ids) doc.transform(id, translation(deltas[i]!.x, deltas[i]!.y)); }));
}

function alignSelected(kind: AlignKind): void {
  const units = selectedUnits();
  const toBed = (document.getElementById("align-to") as HTMLSelectElement).value === "bed";
  if (!units.length) return;
  if (!toBed && units.length < 2) { notify("Select two or more shapes, or choose Align to bed."); return; }
  const ref = toBed ? { minX: 0, minY: 0, maxX: machine.bed.widthMm, maxY: machine.bed.heightMm } : unionBounds(units);
  moveUnits(units, alignDeltas(units, kind, ref));
}

function distributeSelected(axis: "h" | "v"): void {
  const units = selectedUnits();
  if (units.length < 3) { notify("Select three or more shapes to space them evenly."); return; }
  moveUnits(units, distributeDeltas(units, axis));
}

// ---- copy / cut / paste / duplicate ----
let clipboard: ClipData | null = null; // in-app copy, used by the buttons and as a fallback
let clipboardText: string | null = null; // the text we last put on the system clipboard, to recognise our own copy
let pasteCount = 0; // each paste of the same copy steps further from the original
const PASTE_STEP_MM = 5;

function copySelected(): string | null {
  if (!selected.size) return null;
  clipboard = doc.copyOut(selected);
  clipboardText = serializeClip(clipboard);
  pasteCount = 0;
  refreshActions(); // Paste becomes available straight away
  return clipboardText;
}

function pasteClip(data: ClipData | null): void {
  if (!data) return;
  pasteCount++;
  const d = PASTE_STEP_MM * pasteCount;
  edit(() => { selected = new Set(doc.pasteIn(data, d, -d)); });
}

function duplicateSelected(): void {
  const data = selected.size ? doc.copyOut(selected) : null;
  if (!data) return;
  edit(() => { selected = new Set(doc.pasteIn(data, PASTE_STEP_MM, -PASTE_STEP_MM)); });
}

// The browser's copy/cut/paste events need no permission prompt and carry the shapes through the system clipboard.
const inTextField = (e: Event) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
document.addEventListener("copy", (e) => {
  if (inTextField(e)) return;
  const text = copySelected();
  if (text === null) return;
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
});
document.addEventListener("cut", (e) => {
  if (inTextField(e)) return;
  const text = copySelected();
  if (text === null) return;
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
  deleteSelected();
});
document.addEventListener("paste", (e) => {
  if (inTextField(e)) return;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (text !== clipboardText) { // not our own last copy: it may have come from another tab
    const parsed = parseClip(text);
    if (parsed) { clipboard = parsed; clipboardText = text; pasteCount = 0; }
  }
  if (!clipboard) return;
  e.preventDefault();
  pasteClip(clipboard);
});
on("copy", () => { copySelected(); });
on("paste", () => pasteClip(clipboard));
on("dup", () => duplicateSelected());

function groupSelected(): void {
  if (doc.expand(selected).length < 2) return;
  edit(() => { doc.group([...selected]); selected = new Set(doc.expand(selected)); });
}

function ungroupSelected(): void {
  if (!doc.state.objects.some((o) => selected.has(o.id) && o.group !== undefined)) return;
  edit(() => doc.ungroup([...selected]));
}

function deleteSelected(): void {
  if (selected.size || selectedDims.size) edit(() => { doc.remove([...selected]); selected.clear(); doc.removeDimensions([...selectedDims]); selectedDims.clear(); });
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
  if (tool === "spline" && splinePts.length && e.key === "Enter") { e.preventDefault(); splineFinish(false); }
  else if (tool === "spline" && splinePts.length && e.key === "Escape") splineCancel();
  else if (tool === "spline" && splinePts.length && (e.key === "Backspace" || e.key === "Delete")) { e.preventDefault(); splinePts.pop(); draw(); }
  else if (tool === "pen" && penPoints.length && e.key === "Enter") { e.preventDefault(); penFinish(false); }
  else if (tool === "pen" && penPoints.length && e.key === "Escape") penCancel();
  else if (tool === "dim" && dimDraft && e.key === "Escape") { dimDraft = null; draw(); }
  else if (tool === "pen" && penPoints.length && (e.key === "Backspace" || e.key === "Delete")) { penPoints.pop(); draw(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && deleteSelectedNode()) { e.preventDefault(); }
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); }
  else if (e.key.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) setGimbal(!showGimbal);
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? doc.redo() : doc.undo()) && (selected.clear(), selectedDims.clear(), draw()); }
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
  if (path) edit(() => { selected = new Set([doc.add(path, IDENTITY, activeLayer).id]); });
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

/** Finish the Spline tool: a smooth curve through the clicked points (closed or open). */
function splineFinish(closed: boolean): void {
  const points = cleanPoints(splinePts, closed);
  const path = splinePath(points, closed);
  splinePts = [];
  penCursor = null;
  if (!path) { notify(closed ? "A closed spline needs at least 3 points." : "A spline needs at least 2 points."); draw(); return; }
  const isLine = path.segs.length === 1 && path.segs[0]!.t === "l";
  edit(() => {
    const o = doc.add(path, IDENTITY, activeLayer);
    if (!isLine) o.spline = { points, closed };
    selected = new Set([o.id]);
  });
}
const splineCancel = () => { if (splinePts.length) { splinePts = []; penCursor = null; draw(); } };

/** A click with the Spline tool: add a point, or close the curve when the first point is clicked again. */
function splineClick(p: Point): void {
  const first = splinePts[0];
  if (first && splinePts.length >= 3) {
    const a = bedToScreen(view, first), b = bedToScreen(view, p);
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 10) { splineFinish(true); return; }
  }
  const last = splinePts[splinePts.length - 1];
  if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) return; // the second click of a double-click
  splinePts.push(p);
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

const isDrawTool = () => tool === "rect" || tool === "rrect" || tool === "ellipse" || tool === "circle" || tool === "line" || tool === "polygon" || tool === "star" || tool === "measure";

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
  if (tool === "nodes") {
    if (e.button !== 0) return;
    const hit = nodeAt(e);
    if (hit) {
      nodeSel = { id: hit.o.id, index: hit.index };
      nodeDrag = { id: hit.o.id, index: hit.index, base: transformPath(hit.o.path, hit.o.matrix), started: false };
      draw();
      return;
    }
    const r = canvas.getBoundingClientRect();
    const id = pickObject(new paper.Point(e.clientX - r.left, e.clientY - r.top));
    selected = id === undefined ? new Set() : new Set([id]);
    nodeSel = null;
    draw();
    return;
  }
  const gh = gizmoAt(e);
  if (gh) { e.preventDefault(); startGizmoDrag(gh, e); return; }
  if (tool === "radius") { if (e.button === 0) doCorner(bedPt(e)); return; }
  if (tool === "tab") { if (e.button === 0) doTab(bedPt(e)); return; }
  if (tool === "pen") { if (e.button === 0) penClick(snapPt(bedPt(e), e)); return; }
  if (tool === "spline") { if (e.button === 0) splineClick(snapPt(bedPt(e), e)); return; }
  if (tool === "dim") { if (e.button === 0) dimClick(snapPt(bedPt(e), e)); return; }
  if (tool === "dimr") { if (e.button === 0) dimRadialClick(e); return; }
  if (tool === "text") { e.preventDefault(); placeText(snapPt(bedPt(e), e)); snapMarker = null; return; } // preventDefault: keep focus on the text box
  const p = isDrawTool() ? snapPt(bedPt(e), e) : bedPt(e);
  dragStart = dragLast = p;
  moved = false;
  if (tool === "measure") { measureLine = { a: p, b: p }; draw(); return; }
  if (tool === "trim") { doTrim(p); trimPreview = null; draw(); return; }
  if (selectish()) {
    const r = canvas.getBoundingClientRect();
    const dimHit = showDims ? pickDimension(doc.state.dimensions, p, 8 / view.scale) : undefined;
    if (dimHit) { // a dimension: select it (Delete removes it)
      if (!e.shiftKey) { selected.clear(); selectedDims = new Set(); }
      selectedDims.has(dimHit) ? selectedDims.delete(dimHit) : selectedDims.add(dimHit);
      dragStart = dragLast = null;
      refreshActions();
      draw();
      return;
    }
    if (!e.shiftKey) selectedDims = new Set();
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
  if (nodeDrag) {
    const o = doc.get(nodeDrag.id);
    if (!o) return;
    if (!nodeDrag.started) { doc.checkpoint(); if (!o.spline) doc.convertText([o.id]); nodeDrag.started = true; }
    const cur = snapPt(bedPt(e), e);
    if (o.spline) { // a spline's nodes are the points its curve passes through: re-fit the curve
      const pts = nodePoints(nodeDrag.base);
      pts[nodeDrag.index] = cur;
      const fitted = splinePath(pts, o.spline.closed);
      if (fitted) { o.path = fitted; o.spline = { points: pts, closed: o.spline.closed }; }
    } else o.path = moveNode(nodeDrag.base, nodeDrag.index, cur);
    o.matrix = [...IDENTITY] as Matrix;
    draw();
    return;
  }
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
  if (tool === "pen" || tool === "spline") { penCursor = snapPt(raw, e); draw(); return; }
  if (tool === "dim") { dimCursor = snapPt(raw, e); draw(); return; }
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
  } else if (selectish() && selected.size) {
    if (!moved) { doc.checkpoint(); moved = true; moveBounds = selectionBounds(doc.state.objects, selected); moveApplied = { x: 0, y: 0 }; }
    const want = snapMove({ x: p.x - dragStart.x, y: p.y - dragStart.y }, e);
    const step = { x: want.x - moveApplied.x, y: want.y - moveApplied.y };
    for (const id of selected) doc.transform(id, translation(step.x, step.y));
    moveApplied = want;
    dragLast = p;
  } else if (!selectish()) {
    preview = { tool, a: dragStart, b: p };
  }
  draw();
});

window.addEventListener("mouseup", (e) => {
  if (panning) { panning = null; setSpace(spaceDown); return; }
  if (nodeDrag) { nodeDrag = null; snapMarker = null; draw(); return; }
  if (gizmoDrag) { gizmoDrag = null; moveBounds = null; snapMarker = null; gizmoHover = null; canvas.style.cursor = ""; draw(); return; }
  if (dragStart && !selectish()) {
    const sh = shapeFor(tool, dragStart, snapPt(bedPt(e), e));
    if (sh) edit(() => { selected = new Set([doc.add(sh.path, translation(sh.at.x, sh.at.y), activeLayer).id]); });
  }
  marquee = null;
  moveBounds = null;
  snapMarker = null;
  dragStart = dragLast = null;
  preview = null;
  draw();
});

canvas.addEventListener("dblclick", () => {
  if (tool === "pen" && penPoints.length) penFinish(penPoints.length >= 3);
  else if (tool === "spline" && splinePts.length) splineFinish(false);
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  view = zoomAt(view, { x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  draw();
}, { passive: false });

// ---- Tools menu (less-used tools) ----
const toolsBtn = document.getElementById("tools-btn") as HTMLButtonElement;
const toolsList = document.getElementById("tools-list") as HTMLElement;
function setToolsMenu(open: boolean): void {
  toolsList.hidden = !open;
  toolsBtn.setAttribute("aria-expanded", String(open));
}
toolsBtn.addEventListener("click", (e) => { e.stopPropagation(); setToolsMenu(toolsList.hasAttribute("hidden")); });
document.addEventListener("click", (e) => { if (!toolsList.hasAttribute("hidden") && !(e.target as Element).closest("#tools-menu")) setToolsMenu(false); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !toolsList.hasAttribute("hidden")) { setToolsMenu(false); toolsBtn.focus(); } }, true);
/** Add generated shapes as one group, bounding box bottom-left at (20, 20) mm on the bed, ready to move. */
function insertGenerated(items: TestItem[], what: string): void {
  const paths = items.map((i) => i.path);
  const min = designMin(paths);
  edit(() => {
    const group = doc.state.nextGroup++;
    selected = new Set(items.map((i) => {
      const o = doc.add(i.path, translation(20 - min.x, 20 - min.y), i.layer);
      o.group = group;
      if (i.settings) o.settings = { ...i.settings };
      return o.id;
    }));
  });
  notify(`${what} added. Move it where you want it, then cut it.`);
}

async function materialTestGridDialog(): Promise<void> {
  const r = resolvePreset(findPreset(doc.state.materialId) ?? presetStore[0]!, machine.id);
  const v = await openDialog("Material test grid", [
    { key: "mode", label: "Cells", type: "select", value: "cut", options: [{ value: "cut", label: "Cut through" }, { value: "score", label: "Score only" }] },
    { key: "cellMm", label: "Cell size (mm)", type: "number", value: 10, min: 2 },
    { key: "powerMin", label: "Power min (%)", type: "number", value: Math.max(5, Math.round(r.cut.powerPct * 0.4)), min: 0, max: 100 },
    { key: "powerMax", label: "Power max (%)", type: "number", value: 100, min: 0, max: 100 },
    { key: "powerSteps", label: "Power steps", type: "number", value: 5, min: 1, max: 12, integer: true },
    { key: "speedMin", label: "Speed min (mm/s)", type: "number", value: Math.round(r.cut.speedMmPerS * 50) / 100, min: 0.1 },
    { key: "speedMax", label: "Speed max (mm/s)", type: "number", value: Math.round(r.cut.speedMmPerS * 200) / 100, min: 0.1 },
    { key: "speedSteps", label: "Speed steps", type: "number", value: 5, min: 1, max: 12, integer: true },
    { key: "gapMm", label: "Gap (mm)", type: "number", value: 4, min: 0 },
    { key: "labelMm", label: "Label size (mm)", type: "number", value: 3, min: 1.5 },
  ], { intro: "Cuts a grid of squares, power left to right and speed bottom to top, each with a scored label. The best cell shows the setting to use.", ok: "Add grid" });
  if (!v) return;
  const p = v as unknown as TestGridParams;
  const error = validateTestGrid(p);
  if (error) { notify(error); return; }
  insertGenerated(testGrid(p), "Material test grid");
}

async function kerfTestDialog(): Promise<void> {
  const preset = findPreset(doc.state.materialId) ?? presetStore[0]!;
  const v = await openDialog("Kerf test", [
    { key: "thicknessMm", label: "Material thickness (mm)", type: "number", value: preset.thicknessMm, min: 0.1 },
    { key: "count", label: "Slots", type: "number", value: 8, min: 2, max: 20, integer: true },
    { key: "minWidthMm", label: "Narrowest slot (mm)", type: "number", value: Math.round((preset.thicknessMm - 0.3) * 100) / 100, min: 0.1 },
    { key: "stepMm", label: "Step between slots (mm)", type: "number", value: 0.05, min: 0.01, max: 1 },
    { key: "slotLengthMm", label: "Slot length (mm)", type: "number", value: 12, min: 5, integer: true },
    { key: "labelMm", label: "Label size (mm)", type: "number", value: 3, min: 1.5 },
  ], { intro: "Cut the coupon, then push a strip of the same material into each slot. Kerf = thickness minus the width of the slot that grips it. Enter that value in the material.", ok: "Add coupon" });
  if (!v) return;
  const p = v as unknown as Parameters<typeof validateKerfTest>[0];
  const error = validateKerfTest(p);
  if (error) { notify(error); return; }
  insertGenerated(kerfTest(p), "Kerf test coupon");
}

async function fingerBoxDialog(): Promise<void> {
  const preset = findPreset(doc.state.materialId) ?? presetStore[0]!;
  const v = await openDialog("Finger-joint box", [
    { key: "widthMm", label: "Width (mm)", type: "number", value: 100, min: 20 },
    { key: "depthMm", label: "Depth (mm)", type: "number", value: 80, min: 20 },
    { key: "heightMm", label: "Height (mm)", type: "number", value: 50, min: 20 },
    { key: "thicknessMm", label: "Material thickness (mm)", type: "number", value: preset.thicknessMm, min: 0.1 },
    { key: "fingerMm", label: "Finger width (mm)", type: "number", value: Math.max(6, Math.round(preset.thicknessMm * 3)), min: 3, hint: "Target width: it is adjusted slightly so a whole number of fingers fit each edge" },
    { key: "lid", label: "Lid", type: "select", value: "no", options: [{ value: "no", label: "No (open top)" }, { value: "yes", label: "Yes (fingered, glued)" }] },
  ], { intro: "Cuts the panels of a box with interlocking fingers: base, front and back, left and right (and a lid). Sizes are the outside of the box. Kerf is not allowed for here: set it in the material.", ok: "Add panels" });
  if (!v) return;
  const p: FingerBoxParams = { ...(v as unknown as FingerBoxParams), lid: v.lid === "yes" };
  const error = validateFingerBox(p);
  if (error) { notify(error); return; }
  insertGenerated(fingerBox(p), "Finger-joint box");
}

async function boxNetDialog(): Promise<void> {
  const v = await openDialog("Box net", [
    { key: "widthMm", label: "Width (mm)", type: "number", value: 100, min: 10 },
    { key: "depthMm", label: "Depth (mm)", type: "number", value: 80, min: 10 },
    { key: "heightMm", label: "Height (mm)", type: "number", value: 40, min: 10 },
    { key: "flanges", label: "Glue flanges", type: "select", value: "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }], hint: "Tabs on the side walls that fold in and are glued against the front and back walls" },
    { key: "flangeMm", label: "Flange width (mm)", type: "number", value: 10, min: 3 },
  ], { intro: "The flat pattern for an open-topped box (base and four walls). Cut lines are the outline; score lines are the folds. Dimensions are the outside size.", ok: "Add net" });
  if (!v) return;
  const p: BoxNetParams = { ...(v as unknown as BoxNetParams), flanges: v.flanges === "yes" };
  const error = validateBoxNet(p);
  if (error) { notify(error); return; }
  insertGenerated(boxNet(p), "Box net");
}

/** Make copies of the selection, one per matrix (applied on top of each shape's own placement), then select everything. */
function repeatSelected(matrices: Matrix[], what: string): void {
  const data = doc.copyOut(selected);
  if (matrices.length * data.objects.length > 20000) { notify("That would make too many shapes. Use fewer copies."); return; }
  const original = [...selected];
  edit(() => {
    const made: number[] = [];
    for (const m of matrices) for (const id of doc.pasteIn(data, 0, 0)) { doc.transform(id, m); made.push(id); }
    selected = new Set([...original, ...made]);
  });
  notify(`${what}: ${matrices.length} ${matrices.length === 1 ? "copy" : "copies"} added.`);
}

async function linearRepeatDialog(): Promise<void> {
  const b = selectionBounds(doc.state.objects, selected);
  if (!b) { notify("Select the shapes to repeat first."); return; }
  const v = await openDialog("Linear repeat", [
    { key: "countX", label: "Columns (to the right)", type: "number", value: 3, min: 1, max: 100, integer: true },
    { key: "countY", label: "Rows (upwards)", type: "number", value: 2, min: 1, max: 100, integer: true },
    { key: "gapX", label: "Gap between columns (mm)", type: "number", value: 5 },
    { key: "gapY", label: "Gap between rows (mm)", type: "number", value: 5 },
    { key: "rowShiftMm", label: "Shift each row sideways (mm)", type: "number", value: 0, hint: "Offsets every further row along X, for brick patterns" },
  ], { intro: "Counts include the original. Gaps are the space between neighbouring shapes, edge to edge.", ok: "Repeat" });
  if (!v) return;
  const p = v as unknown as LinearParams;
  const error = validateLinear(p);
  if (error) { notify(error); return; }
  repeatSelected(linearOffsets(b, p).map((o): Matrix => translation(o.x, o.y)), "Linear repeat");
}

async function circularArrayDialog(): Promise<void> {
  const b = selectionBounds(doc.state.objects, selected);
  if (!b) { notify("Select the shapes to repeat first."); return; }
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const v = await openDialog("Circular array", [
    { key: "count", label: "Shapes around the circle", type: "number", value: 6, min: 2, max: 360, integer: true },
    { key: "sweepDeg", label: "Sweep (degrees)", type: "number", value: 360, min: -360, max: 360, hint: "360 = full circle. Negative goes clockwise." },
    { key: "centreX", label: "Centre X (mm)", type: "number", value: Math.round(cx * 100) / 100 },
    { key: "centreY", label: "Centre Y (mm)", type: "number", value: Math.round((cy - 40) * 100) / 100 },
    { key: "rotate", label: "Turn copies with the circle", type: "select", value: "yes", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No: keep them upright" }] },
  ], { intro: "Counts include the original. The centre starts 40 mm below the selection: change it to put the circle where you want.", ok: "Make array" });
  if (!v) return;
  const p: CircularParams = { count: v.count as number, sweepDeg: v.sweepDeg as number, centre: { x: v.centreX as number, y: v.centreY as number }, rotate: v.rotate === "yes" };
  const error = validateCircular(p);
  if (error) { notify(error); return; }
  repeatSelected(circularMatrices(b, p), "Circular array");
}

/** Flip the selection left-right or top-bottom, in place. */
function flipSelected(axis: "h" | "v"): void {
  const b = selectionBounds(doc.state.objects, selected);
  if (!b) return;
  const m = mirrorMatrix(b, axis);
  edit(() => { for (const id of selected) doc.transform(id, m); });
}
on("flip-h", () => flipSelected("h"));
on("flip-v", () => flipSelected("v"));

// ---- repair: join, close, explode, nodes ----
const joinTol = () => Math.max(0.001, parseFloat((document.getElementById("join-tol") as HTMLInputElement).value) || 0.05);

/** Join the selected open paths (per layer). Closed shapes are left alone. */
function joinSelected(): void {
  const objs = doc.state.objects.filter((o) => selected.has(o.id));
  const open = objs.filter((o) => !o.path.closed);
  if (open.length < 2) { notify("Select two or more open paths to join."); return; }
  const tol = joinTol();
  let merges = 0, closed = 0;
  const made: { path: Path; layer: LayerType }[] = [];
  for (const layer of ["cut", "score"] as LayerType[]) {
    const mine = open.filter((o) => o.layer === layer);
    if (!mine.length) continue;
    const r = joinPaths(mine.map((o) => transformPath(o.path, o.matrix)), tol);
    merges += r.merges; closed += r.newlyClosed;
    made.push(...r.paths.map((path) => ({ path, layer })));
  }
  if (!merges) { notify(`Nothing to join: no ends are within ${tol} mm. Raise the tolerance in Options.`); return; }
  edit(() => {
    doc.convertText(open.map((o) => o.id));
    doc.remove(open.map((o) => o.id));
    const ids = made.map(({ path, layer }) => doc.add(path, IDENTITY, layer).id);
    selected = new Set([...objs.filter((o) => o.path.closed).map((o) => o.id), ...ids]);
  });
  notify(`Joined ${merges} ${merges === 1 ? "piece" : "pieces"}${closed ? `, closing ${closed} ${closed === 1 ? "shape" : "shapes"}` : ""}.`);
}

function closeSelected(): void {
  const open = doc.state.objects.filter((o) => selected.has(o.id) && !o.path.closed);
  if (!open.length) { notify("No open paths are selected."); return; }
  const tol = joinTol();
  edit(() => {
    for (const o of open) {
      doc.convertText([o.id]);
      o.path = closePath(transformPath(o.path, o.matrix), tol);
      o.matrix = [...IDENTITY] as Matrix;
    }
  });
  notify(`Closed ${open.length} ${open.length === 1 ? "path" : "paths"}.`);
}

function explodeSelected(): void {
  const objs = doc.state.objects.filter((o) => selected.has(o.id));
  const jobs = objs.map((o) => ({ o, pieces: explodePath(transformPath(o.path, o.matrix)) })).filter((j) => j.pieces.length > 1);
  if (!jobs.length) { notify("Nothing to explode: the selected shapes are single edges."); return; }
  edit(() => { selected = new Set(jobs.flatMap((j) => { const ids = replaceWith(j.o, j.pieces); for (const id of ids) delete doc.get(id)!.group; return ids; })); });
  notify(`Exploded into ${jobs.reduce((n, j) => n + j.pieces.length, 0)} edges.`);
}
on("act-join", joinSelected);
on("act-close", closeSelected);
on("act-explode", explodeSelected);

/** The single shape the Nodes tool works on. */
function nodeTarget(): DocObject | null {
  if (selected.size !== 1) return null;
  return doc.get([...selected][0]!) ?? null;
}

/** Make an object's placement part of its path so nodes can be edited in bed space. */
function bakeForNodes(o: DocObject): void {
  doc.convertText([o.id]);
  o.path = transformPath(o.path, o.matrix);
  o.matrix = [...IDENTITY] as Matrix;
}

function nodeAt(e: MouseEvent): { o: DocObject; index: number } | null {
  const o = nodeTarget();
  if (!o) return null;
  const r = canvas.getBoundingClientRect();
  const m = { x: e.clientX - r.left, y: e.clientY - r.top };
  let best: { index: number; d: number } | null = null;
  nodePoints(transformPath(o.path, o.matrix)).forEach((q, index) => {
    const c = bedToScreen(view, q);
    const d = Math.hypot(c.x - m.x, c.y - m.y);
    if (d <= 8 && (!best || d < best.d)) best = { index, d };
  });
  return best ? { o, index: (best as { index: number }).index } : null;
}

function deleteSelectedNode(): boolean {
  if (tool !== "nodes" || !nodeSel) return false;
  const o = doc.get(nodeSel.id);
  if (!o) return false;
  const base = transformPath(o.path, o.matrix);
  if (o.spline) {
    const pts = nodePoints(base).filter((_, i) => i !== nodeSel!.index);
    const fitted = splinePath(pts, o.spline.closed);
    if (!fitted) { notify("A spline needs at least 2 points (3 if it is closed)."); return true; }
    const closed = o.spline.closed;
    edit(() => { o.path = fitted; o.spline = fitted.segs.length === 1 && fitted.segs[0]!.t === "l" ? undefined : { points: pts, closed }; o.matrix = [...IDENTITY] as Matrix; });
    nodeSel = null;
    return true;
  }
  const next = deleteNode(base, nodeSel.index);
  if (!next) { notify("A shape needs at least two nodes (three if it is closed)."); return true; }
  edit(() => { doc.convertText([o.id]); o.path = next; o.matrix = [...IDENTITY] as Matrix; });
  nodeSel = null;
  return true;
}

/** Double-click an edge in the Nodes tool to add a node there. */
canvas.addEventListener("dblclick", (e) => {
  if (tool !== "nodes") return;
  const o = nodeTarget();
  if (!o) return;
  const p = bedPt(e);
  const base = transformPath(o.path, o.matrix);
  const q = explicitPath(base);
  const tol = 8 / view.scale;
  let best: { si: number; d: number } | null = null;
  let cur = q.start;
  q.segs.forEach((sg, si) => {
    for (const prim of primsFor(cur, sg)) { const d = distToPrim(p, prim).d; if (d <= tol && (!best || d < best.d)) best = { si, d }; }
    cur = sg.to;
  });
  if (!best) return;
  const inserted = insertNode(base, (best as { si: number }).si, p);
  if (o.spline) { // add a point the curve must pass through, where you clicked on it
    const pts = nodePoints(inserted);
    const fitted = splinePath(pts, o.spline.closed);
    if (fitted) edit(() => { o.path = fitted; o.spline = { points: pts, closed: o.spline!.closed }; o.matrix = [...IDENTITY] as Matrix; });
    return;
  }
  edit(() => { doc.convertText([o.id]); o.path = inserted; o.matrix = [...IDENTITY] as Matrix; });
});

// ---- tabs (bridges) ----
const tabWidth = () => Math.max(0.5, parseFloat((document.getElementById("tab-width") as HTMLInputElement).value) || 3);
const tabCount = () => Math.min(50, Math.max(1, Math.round(parseFloat((document.getElementById("tab-count") as HTMLInputElement).value) || 4)));
const tabbable = (o: DocObject) => o.layer === "cut" && o.path.closed;

/** Click an outline to add a tab there, or click an existing tab to remove it. */
function doTab(p: Point): void {
  const tol = 8 / view.scale;
  for (const o of [...doc.state.objects].reverse().filter(tabbable)) {
    const placed = transformPath(o.path, o.matrix);
    const f = nearestFraction(placed, p, tol);
    if (f === null) continue;
    edit(() => {
      const next = toggleTab(o.tabs, f, tabWidth(), placed);
      if (next.at.length) o.tabs = next; else delete o.tabs;
      selected = new Set(doc.expand([o.id]));
    });
    return;
  }
  notify("Click on the outline of a closed Cut shape.");
}

function autoTabsSelected(): void {
  const objs = doc.state.objects.filter((o) => selected.has(o.id) && tabbable(o));
  if (!objs.length) { notify("Select a closed Cut outline first."); return; }
  const n = tabCount(), w = tabWidth();
  edit(() => { for (const o of objs) o.tabs = { widthMm: w, at: autoTabFractions(n) }; });
  notify(`Added ${n} ${n === 1 ? "tab" : "tabs"} of ${w} mm to ${objs.length} ${objs.length === 1 ? "shape" : "shapes"}.`);
}

function clearTabsSelected(): void {
  const objs = doc.state.objects.filter((o) => selected.has(o.id) && o.tabs);
  if (!objs.length) { notify("The selection has no tabs."); return; }
  edit(() => { for (const o of objs) delete o.tabs; });
}
on("act-tabs", autoTabsSelected);
on("tab-clear", clearTabsSelected);

// ---- corner radius / chamfer ----
const radiusEl = document.getElementById("radius") as HTMLInputElement;
const radiusModeEl = document.getElementById("radius-mode") as HTMLSelectElement;
const cornerSetting = (): { size: number; mode: CornerMode } => ({ size: Math.max(0.1, parseFloat(radiusEl.value) || 5), mode: radiusModeEl.value as CornerMode });

/** Replace an object by baked paths, keeping layer, group and per-shape settings. Text is converted first. */
function replaceWith(old: DocObject, paths: Path[]): number[] {
  doc.convertText([old.id]);
  const { layer, group, settings } = old;
  doc.remove([old.id]);
  return paths.map((p) => { const o = doc.add(p, IDENTITY, layer); o.group = group; if (settings) o.settings = { ...settings }; return o.id; });
}

/** Round (or chamfer) the corner nearest the click. */
function doCorner(p: Point): void {
  const placed = doc.state.objects.map((o) => ({ o, path: transformPath(o.path, o.matrix) }));
  const hit = nearestCorner(placed, p, 10 / view.scale);
  if (!hit) return;
  const { size, mode } = cornerSetting();
  const r = filletVertices(hit.item.path, [hit.vertex], size, mode);
  if (!r.corners) { notify("That corner is too short to round."); return; }
  edit(() => { selected = new Set(replaceWith(hit.item.o, [r.path])); });
  if (r.clamped) notify("The corner size was reduced to fit the edges.");
}

/** Round (or chamfer) every straight corner of the selected shapes. */
function roundAllSelected(): void {
  const { size, mode } = cornerSetting();
  const jobs = doc.state.objects.filter((o) => selected.has(o.id)).map((o) => ({ o, r: filletAll(transformPath(o.path, o.matrix), size, mode) })).filter((j) => j.r.corners > 0);
  if (!jobs.length) { notify("No straight-edged corners to round in the selection."); return; }
  edit(() => { selected = new Set(jobs.flatMap((j) => replaceWith(j.o, [j.r.path]))); });
  if (jobs.some((j) => j.r.clamped)) notify("Some corners were reduced to fit their edges.");
}
on("round-all", roundAllSelected);

const menuActions: Record<string, () => void> = { "linear-repeat": () => void linearRepeatDialog(), "circular-array": () => void circularArrayDialog(), "test-grid": () => void materialTestGridDialog(), "kerf-test": () => void kerfTestDialog(), "box-net": () => void boxNetDialog(), "finger-box": () => void fingerBoxDialog() };
on("act-linear", () => menuActions["linear-repeat"]!());
on("act-circular", () => menuActions["circular-array"]!());
toolsList.querySelectorAll<HTMLButtonElement>("[data-menu]").forEach((b) =>
  b.addEventListener("click", () => { setToolsMenu(false); (menuActions[b.dataset.menu!] ?? (() => notify("Not built yet.")))(); }),
);

initServerUi({
  objects: () => doc.state.objects,
  dimensions: () => doc.state.dimensions,
  materialId: () => doc.state.materialId,
  blocker: () =>
    !doc.state.objects.length ? "Draw or import something first."
    : !canSubmit(doc.state.objects, machine.bed) ? "Part of the design is off the bed (shown red). Move it onto the bed first."
    : null,
  notify,
  load: (shapes, materialId, dims) => {
    edit(() => {
      doc.state.objects = [];
      doc.state.dimensions = dims;
      selectedDims = new Set();
      selected = new Set();
      for (const sh of shapes) {
        const o = doc.add(sh.path, sh.matrix, sh.layer);
        if (sh.tabs) o.tabs = sh.tabs;
        if (sh.settings) o.settings = sh.settings;
      }
      if (materialId && findPreset(materialId)) doc.state.materialId = materialId;
    });
    fillMaterials();
    refreshLayerUI();
    fit();
  },
  clear: () => { doc.reset(); selected = new Set(); selectedDims = new Set(); dimDraft = null; fillMaterials(); refreshLayerUI(); draw(); },
  presetsChanged: () => { fillMaterials(); refreshLayerUI(); },
});

paper.view.onResize = fit;
fit();
fillFontSelect();
loadBundledFonts(async (file) => (await fetch(`/fonts/${file}`)).arrayBuffer())
  .then(() => fillFontSelect(defaultFont))
  .catch((err) => console.error("Could not load bundled fonts", err));

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
