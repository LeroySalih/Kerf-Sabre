// Standalone export of the edited design to SVG and DXF (mm, Y-up in DXF).
import type { Point } from "./coords";
import type { DocObject } from "./doc";
import { arcSweep, boundsOf, flatten, transformPath, type Path } from "./geometry";

const num = (n: number) => (Math.round(n * 1e4) / 1e4).toString();
const placed = (o: DocObject): Path => transformPath(o.path, o.matrix);

const SVG_STROKE = { score: "#0000ff", cut: "#ff0000" } as const;
const DXF_COLOUR = { score: 5, cut: 1 } as const; // ACI blue, red

export function toSVG(objects: DocObject[]): string {
  const paths = objects.map((o) => ({ o, p: placed(o) }));
  const bs = paths.map(({ p }) => boundsOf(p));
  const minX = Math.min(0, ...bs.map((b) => b.minX)), maxX = Math.max(0, ...bs.map((b) => b.maxX));
  const minY = Math.min(0, ...bs.map((b) => b.minY)), maxY = Math.max(0, ...bs.map((b) => b.maxY));
  const w = maxX - minX, h = maxY - minY;
  const Y = (y: number) => num(-y); // SVG is Y-down
  const body = paths.map(({ o, p }) => {
    let d = `M${num(p.start.x)} ${Y(p.start.y)}`;
    let cur: Point = p.start;
    for (const s of p.segs) {
      if (s.t === "l") d += `L${num(s.to.x)} ${Y(s.to.y)}`;
      else if (s.t === "c") d += `C${num(s.c1.x)} ${Y(s.c1.y)} ${num(s.c2.x)} ${Y(s.c2.y)} ${num(s.to.x)} ${Y(s.to.y)}`;
      else {
        const r = Math.hypot(cur.x - s.c.x, cur.y - s.c.y);
        const large = Math.abs(arcSweep(s.c, cur, s.to, s.ccw)) > Math.PI ? 1 : 0;
        d += `A${num(r)} ${num(r)} 0 ${large} ${s.ccw ? 0 : 1} ${num(s.to.x)} ${Y(s.to.y)}`;
      }
      cur = s.to;
    }
    if (p.closed) d += "Z";
    return `  <path id="${o.layer}-${o.id}" data-layer="${o.layer}" d="${d}" fill="none" stroke="${SVG_STROKE[o.layer]}" stroke-width="0.1"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}mm" height="${num(h)}mm" viewBox="${num(minX)} ${num(-maxY)} ${num(w)} ${num(h)}">\n${body.join("\n")}\n</svg>\n`;
}

export function toDXF(objects: DocObject[]): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(9, "$INSUNITS"); g(70, 4); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES"); g(0, "TABLE"); g(2, "LAYER"); g(70, 2);
  for (const [name, colour] of [["SCORE", DXF_COLOUR.score], ["CUT", DXF_COLOUR.cut]] as const) {
    g(0, "LAYER"); g(2, name); g(70, 0); g(62, colour); g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  const line = (layer: string, a: Point, b: Point) => {
    g(0, "LINE"); g(8, layer); g(10, num(a.x)); g(20, num(a.y)); g(30, 0); g(11, num(b.x)); g(21, num(b.y)); g(31, 0);
  };
  for (const o of objects) {
    const layer = o.layer.toUpperCase();
    const p = placed(o);
    let cur = p.start;
    for (const s of p.segs) {
      if (s.t === "l") line(layer, cur, s.to);
      else if (s.t === "a") {
        // DXF arcs are always counter-clockwise: swap ends for clockwise ones.
        const [from, to] = s.ccw ? [cur, s.to] : [s.to, cur];
        const deg = (q: Point) => ((Math.atan2(q.y - s.c.y, q.x - s.c.x) * 180) / Math.PI + 360) % 360;
        g(0, "ARC"); g(8, layer); g(10, num(s.c.x)); g(20, num(s.c.y)); g(30, 0);
        g(40, num(Math.hypot(cur.x - s.c.x, cur.y - s.c.y))); g(50, num(deg(from))); g(51, num(deg(to)));
      } else {
        const pts = flatten({ start: cur, segs: [s], closed: false });
        for (let i = 1; i < pts.length; i++) line(layer, pts[i - 1]!, pts[i]!);
      }
      cur = s.to;
    }
    if (p.closed && (cur.x !== p.start.x || cur.y !== p.start.y)) line(layer, cur, p.start);
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return out.join("\n") + "\n";
}
