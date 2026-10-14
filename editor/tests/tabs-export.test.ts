import { describe, expect, it } from "vitest";
import { parseClip, serializeClip } from "../src/clipboard";
import { Doc } from "../src/doc";
import { toDXF, toSVG } from "../src/export";
import { rectangle, translation } from "../src/geometry";
import { autoTabFractions } from "../src/tabs";

const build = (layer: "cut" | "score" = "cut") => {
  const d = new Doc();
  const o = d.add(rectangle(20, 10), translation(5, 5), layer);
  o.tabs = { widthMm: 2, at: autoTabFractions(4) };
  return { d, o };
};
const lengthOfLines = (dxf: string) => {
  const lines = [...dxf.matchAll(/\nLINE\n8\n\w+\n10\n(-?[\d.]+)\n20\n(-?[\d.]+)\n30\n0\n11\n(-?[\d.]+)\n21\n(-?[\d.]+)\n/g)];
  return lines.reduce((s, m) => s + Math.hypot(+m[3]! - +m[1]!, +m[4]! - +m[2]!), 0);
};

describe("tabs in exports", () => {
  it("SVG: a tabbed Cut outline becomes four open pieces with ids that stay unique", () => {
    const svg = toSVG(build().d.state.objects);
    const paths = [...svg.matchAll(/<path id="([^"]+)"[^>]* d="([^"]+)"/g)];
    expect(paths.length).toBe(4);
    expect(new Set(paths.map((m) => m[1])).size).toBe(4);
    expect(paths.every((m) => !m[2]!.endsWith("Z"))).toBe(true);
  });

  it("SVG: the drawing keeps the full outline's size", () => {
    const w = (o: Doc) => /width="([\d.]+)mm"/.exec(toSVG(o.state.objects))![1];
    const plain = new Doc();
    plain.add(rectangle(20, 10), translation(5, 5), "cut");
    expect(w(build().d)).toBe(w(plain));
  });

  it("DXF: the cut length is the perimeter minus the tabs (60 - 4 x 2)", () => {
    expect(lengthOfLines(toDXF(build().d.state.objects))).toBeCloseTo(52, 3);
  });

  it("DXF without tabs cuts the whole perimeter", () => {
    const d = new Doc();
    d.add(rectangle(20, 10), translation(5, 5), "cut");
    expect(lengthOfLines(toDXF(d.state.objects))).toBeCloseTo(60, 3);
  });

  it("tabs only apply to Cut: a Score outline is exported whole", () => {
    const svg = toSVG(build("score").d.state.objects);
    expect([...svg.matchAll(/<path /g)].length).toBe(1);
    expect(svg).toMatch(/d="[^"]*Z"/);
  });

  it("tabs follow the shape when it moves", () => {
    const { d, o } = build();
    d.transform(o.id, translation(100, 50));
    expect(toSVG(d.state.objects)).toContain("data-layer=\"cut\"");
    expect(lengthOfLines(toDXF(d.state.objects))).toBeCloseTo(52, 3);
  });
});

describe("tabs through copy and paste", () => {
  it("are copied, and the copy does not share the array", () => {
    const { d, o } = build();
    const ids = d.pasteIn(d.copyOut([o.id]), 10, 0);
    const copy = d.get(ids[0]!)!;
    expect(copy.tabs).toEqual(o.tabs);
    copy.tabs!.at.push(0.9);
    expect(o.tabs!.at.length).toBe(4);
  });
  it("survive the clipboard text round trip", () => {
    const { d, o } = build();
    const clip = d.copyOut([o.id]);
    expect(parseClip(serializeClip(clip))!.objects[0]!.tabs).toEqual(o.tabs);
  });
  it("bad tab data on the clipboard is rejected", () => {
    const { d, o } = build();
    const good = JSON.parse(serializeClip(d.copyOut([o.id])));
    const bad = (m: (c: any) => void) => { const c = structuredClone(good); m(c); return parseClip(JSON.stringify(c)); };
    expect(bad((c) => { c.objects[0].tabs.widthMm = -1; })).toBeNull();
    expect(bad((c) => { c.objects[0].tabs.at = [2]; })).toBeNull();
    expect(bad((c) => { c.objects[0].tabs.at = "x"; })).toBeNull();
    expect(bad(() => {})).not.toBeNull();
  });
});
