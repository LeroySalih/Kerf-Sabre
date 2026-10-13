import { describe, expect, it } from "vitest";
import { parseClip, serializeClip } from "../src/clipboard";
import { Doc } from "../src/doc";
import { circle, rectangle, translation } from "../src/geometry";
import { loadBundledFonts, textToPaths } from "../src/text";
import { readFileSync } from "node:fs";

const build = () => {
  const d = new Doc();
  const a = d.add(rectangle(10, 10), translation(5, 5), "cut").id;
  const b = d.add(circle(3), translation(30, 5), "score").id;
  const c = d.add(rectangle(4, 4), translation(50, 5), "cut").id;
  d.group([a, b]);
  return { d, a, b, c };
};

describe("copy / paste in the document", () => {
  it("copies whole groups even if only one member is selected", () => {
    const { d, a, b } = build();
    expect(d.copyOut([a]).objects.length).toBe(2);
    expect(d.copyOut([b]).objects.length).toBe(2);
  });

  it("pastes offset copies with fresh ids and a separate group", () => {
    const { d, a, c } = build();
    const clip = d.copyOut([a, c]);
    const ids = d.pasteIn(clip, 5, -5);
    expect(ids.length).toBe(3);
    expect(d.state.objects.length).toBe(6);
    const orig = d.get(a)!, copy = d.get(ids[0]!)!;
    expect(copy.matrix[4]).toBe(orig.matrix[4] + 5);
    expect(copy.matrix[5]).toBe(orig.matrix[5] - 5);
    expect(copy.layer).toBe(orig.layer);
    expect(copy.group).toBeDefined();
    expect(copy.group).not.toBe(orig.group); // pasted group is its own group
    expect(d.get(ids[1]!)!.group).toBe(copy.group); // members stay together
    expect(d.get(ids[2]!)!.group).toBeUndefined(); // the loose shape stays loose
    expect(d.expand([ids[0]!]).sort()).toEqual([ids[0], ids[1]].sort()); // moving the copy doesn't move the original
  });

  it("does not alias the source geometry", () => {
    const { d, a } = build();
    const ids = d.pasteIn(d.copyOut([a]), 0, 0);
    d.get(ids[0]!)!.path.start.x = 999;
    expect(d.get(a)!.path.start.x).not.toBe(999);
  });

  it("carries live text with a new text id", async () => {
    await loadBundledFonts(async (f) => { const b = readFileSync(new URL(`../public/fonts/${f}`, import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; });
    const d = new Doc();
    const spec = { content: "Hi", font: "dejavu-sans", sizeMm: 10 };
    const t = d.addText(spec, textToPaths(spec), translation(0, 0), "cut");
    const ids = d.pasteIn(d.copyOut(d.textMembers(t)), 20, 0);
    const newText = d.get(ids[0]!)!.textId!;
    expect(newText).not.toBe(t);
    expect(d.state.texts[newText]).toEqual(spec);
    expect(d.textMembers(newText).length).toBe(ids.length);
    d.retext(newText, { ...spec, content: "Bye" }, textToPaths({ ...spec, content: "Bye" }));
    expect(d.state.texts[t]!.content).toBe("Hi"); // editing the copy leaves the original text alone
  });
});

describe("parseClip", () => {
  it("round-trips through text", () => {
    const { d, a, c } = build();
    const clip = d.copyOut([a, c]);
    expect(parseClip(serializeClip(clip))).toEqual(clip);
  });

  it("rejects anything that is not a well-formed clip", () => {
    const { d, a } = build();
    const good = JSON.parse(serializeClip(d.copyOut([a])));
    const bad = (mut: (c: any) => void) => { const c = structuredClone(good); mut(c); return parseClip(JSON.stringify(c)); };
    expect(parseClip("")).toBeNull();
    expect(parseClip(null)).toBeNull();
    expect(parseClip("hello world")).toBeNull();
    expect(parseClip("{not json")).toBeNull();
    expect(parseClip('{"objects":[]}')).toBeNull();
    expect(bad((c) => { c.kerfSabre = 2; })).toBeNull();
    expect(bad((c) => { c.objects = []; })).toBeNull();
    expect(bad((c) => { c.objects[0].matrix = [1, 0, 0]; })).toBeNull();
    expect(bad((c) => { c.objects[0].matrix[0] = null; })).toBeNull();
    expect(bad((c) => { c.objects[0].layer = "engrave"; })).toBeNull();
    expect(bad((c) => { c.objects[0].path.segs[0] = { t: "x" }; })).toBeNull();
    expect(bad((c) => { c.objects[0].path.segs[0].to.x = "5"; })).toBeNull();
    expect(bad((c) => { c.objects[0].textId = 7; })).toBeNull(); // refers to a text that is not there
    expect(bad((c) => { c.objects[0].path.closed = "yes"; })).toBeNull();
    expect(bad(() => {})).not.toBeNull();
  });
});
