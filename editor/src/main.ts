import paper from "paper";
import { bedToScreen, fitView, screenToBed, zoomAt, type Point, type View } from "./coords";
import { Doc, type LayerType } from "./doc";
import { DEFAULT_MM_PER_UNIT, designMin, mmPerUnit, parseDXF, scalePath } from "./dxf-import";
import { toDXF, toSVG } from "./export";
import { IDENTITY, arcMid, circle, line, rectangle, translation, transformPath, type Path } from "./geometry";
import { loadMachineProfiles, type MachineProfile } from "./machine";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const select = document.getElementById("machine") as HTMLSelectElement;
const cursorEl = document.getElementById("cursor") as HTMLElement;

const profiles = loadMachineProfiles();
let machine: MachineProfile = profiles[0]!;
let view: View;
const doc = new Doc();
let selected = new Set<number>();
type Tool = "select" | "rect" | "circle" | "line";
let tool: Tool = "select";
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

function shapeFor(t: Tool, a: Point, b: Point): { path: Path; at: Point } | null {
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (t === "rect" && w > 0.1 && h > 0.1) return { path: rectangle(w, h), at: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) } };
  if (t === "circle") { const r = Math.hypot(b.x - a.x, b.y - a.y); if (r > 0.1) return { path: circle(r), at: a }; }
  if (t === "line" && Math.hypot(w, h) > 0.1) return { path: line(b.x - a.x, b.y - a.y), at: a };
  return null;
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

  for (const o of doc.state.objects) {
    const item = toPaperPath(transformPath(o.path, o.matrix));
    item.data = { id: o.id };
    item.strokeColor = new paper.Color(COLOURS[o.layer]);
    item.strokeWidth = selected.has(o.id) ? 3 : 1.5;
    if (o.path.closed) item.fillColor = new paper.Color(0, 0, 0, 0.01); // hit-testable
    if (selected.has(o.id)) item.dashArray = [6, 3];
  }
  if (preview) {
    const sh = shapeFor(preview.tool, preview.a, preview.b);
    if (sh) {
      const g = toPaperPath(transformPath(sh.path, translation(sh.at.x, sh.at.y)));
      g.strokeColor = new paper.Color("#6b7280");
      g.dashArray = [4, 4];
    }
  }
  paper.view.update();
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
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) =>
  btn.addEventListener("click", () => {
    tool = btn.dataset.tool as Tool;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b === btn));
  }),
);
const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener("click", fn);
on("score", () => selected.size && edit(() => doc.setLayer([...selected], "score")));
on("cut", () => selected.size && edit(() => doc.setLayer([...selected], "cut")));
on("del", () => deleteSelected());
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? doc.redo() : doc.undo()) && (selected.clear(), draw()); }
});

// ---- pointer ----
const bedPt = (e: MouseEvent): Point => {
  const r = canvas.getBoundingClientRect();
  return screenToBed(view, { x: e.clientX - r.left, y: e.clientY - r.top });
};
let dragStart: Point | null = null;
let dragLast: Point | null = null;
let moved = false;

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
  const p = bedPt(e);
  dragStart = dragLast = p;
  moved = false;
  if (tool === "select") {
    const r = canvas.getBoundingClientRect();
    const id = pickObject(new paper.Point(e.clientX - r.left, e.clientY - r.top));
    if (id === undefined) { if (!e.shiftKey) selected.clear(); }
    else if (e.shiftKey) selected.has(id) ? selected.delete(id) : selected.add(id);
    else if (!selected.has(id)) selected = new Set([id]);
    draw();
  }
});

canvas.addEventListener("mousemove", (e) => {
  const p = bedPt(e);
  cursorEl.textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)} mm`;
  if (!dragStart || !dragLast) return;
  if (tool === "select" && selected.size) {
    if (!moved) { doc.checkpoint(); moved = true; }
    for (const id of selected) doc.transform(id, translation(p.x - dragLast.x, p.y - dragLast.y));
    dragLast = p;
  } else if (tool !== "select") {
    preview = { tool, a: dragStart, b: p };
  }
  draw();
});

window.addEventListener("mouseup", (e) => {
  if (dragStart && tool !== "select") {
    const sh = shapeFor(tool, dragStart, bedPt(e));
    if (sh) edit(() => { selected = new Set([doc.add(sh.path, translation(sh.at.x, sh.at.y) ?? IDENTITY).id]); });
  }
  dragStart = dragLast = null;
  preview = null;
  draw();
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  view = zoomAt(view, { x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  draw();
}, { passive: false });

paper.view.onResize = fit;
fit();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
