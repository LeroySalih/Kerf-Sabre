import paper from "paper";
import { bedToScreen, fitView, screenToBed, zoomAt, type View } from "./coords";
import { loadMachineProfiles, type MachineProfile } from "./machine";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const select = document.getElementById("machine") as HTMLSelectElement;
const cursorEl = document.getElementById("cursor") as HTMLElement;

const profiles = loadMachineProfiles();
let machine: MachineProfile = profiles[0]!;
let view: View;

paper.setup(canvas);

function draw(): void {
  paper.project.clear();
  const { widthMm, heightMm } = machine.bed;
  const a = bedToScreen(view, { x: 0, y: 0 });
  const b = bedToScreen(view, { x: widthMm, y: heightMm });
  const bed = new paper.Path.Rectangle(new paper.Point(a.x, b.y), new paper.Point(b.x, a.y));
  bed.strokeColor = new paper.Color("#1f2937");
  bed.fillColor = new paper.Color("#f3f4f6");
  const origin = new paper.Path.Circle(new paper.Point(a.x, a.y), 4);
  origin.fillColor = new paper.Color("#f97316");
  paper.view.update();
}

function fit(): void {
  const { widthMm, heightMm } = machine.bed;
  view = fitView(widthMm, heightMm, paper.view.viewSize.width, paper.view.viewSize.height);
  draw();
}

for (const p of profiles) select.add(new Option(p.name, p.id));
select.addEventListener("change", () => {
  machine = profiles.find((p) => p.id === select.value) ?? machine;
  fit();
});

paper.view.onResize = fit;
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  view = zoomAt(view, { x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  draw();
}, { passive: false });
canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const p = screenToBed(view, { x: e.clientX - r.left, y: e.clientY - r.top });
  cursorEl.textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)} mm`;
});

fit();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
