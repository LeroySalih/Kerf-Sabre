import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { boundsOf, translation, type Path } from "../src/geometry";
import { BUNDLED_FONTS, listFonts, loadBundledFonts, textToPaths, type TextSpec } from "../src/text";

beforeAll(async () => {
  await loadBundledFonts(async (file) => {
    const b = readFileSync(new URL(`../public/fonts/${file}`, import.meta.url));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
});

const spec = (content: string, font = "dejavu-sans", sizeMm = 10): TextSpec => ({ content, font, sizeMm });
const union = (paths: Path[]) => {
  const bs = paths.map(boundsOf);
  return { minX: Math.min(...bs.map((b) => b.minX)), maxX: Math.max(...bs.map((b) => b.maxX)), minY: Math.min(...bs.map((b) => b.minY)), maxY: Math.max(...bs.map((b) => b.maxY)) };
};

describe("outline text", () => {
  it("registers the bundled fonts and the single-line fonts", () => {
    const ids = listFonts().map((f) => f.id);
    for (const f of BUNDLED_FONTS) expect(ids).toContain(f.id);
    expect(ids).toContain("hershey-futural");
  });

  it("an H is one closed contour, Y-up, with the cap height of its font", () => {
    const paths = textToPaths(spec("H"));
    expect(paths.length).toBe(1);
    expect(paths[0]!.closed).toBe(true);
    const b = union(paths);
    expect(b.minY).toBeCloseTo(0, 2); // sits on the baseline, not below it
    expect(b.maxY).toBeCloseTo(7.29, 2); // 0.729 x 10 mm
  });

  it("counters and dots become their own contours", () => {
    expect(textToPaths(spec("O")).length).toBe(2); // outer + hole
    expect(textToPaths(spec("i")).length).toBe(2); // stem + dot
  });

  it("spaces make no contours but take width", () => {
    const tight = union(textToPaths(spec("AB")));
    const spaced = union(textToPaths(spec("A B")));
    expect(textToPaths(spec("A B")).length).toBe(textToPaths(spec("AB")).length);
    expect(spaced.maxX).toBeGreaterThan(tight.maxX + 2);
  });

  it("size scales the geometry linearly", () => {
    const a = union(textToPaths(spec("Kerf", "dejavu-sans", 10)));
    const b = union(textToPaths(spec("Kerf", "dejavu-sans", 20)));
    expect(b.maxX / a.maxX).toBeCloseTo(2, 3);
    expect(b.maxY / a.maxY).toBeCloseTo(2, 3);
  });

  it("different faces give different geometry", () => {
    const regular = union(textToPaths(spec("Kerf Sabre", "dejavu-sans")));
    const bold = union(textToPaths(spec("Kerf Sabre", "dejavu-sans-bold")));
    const mono = union(textToPaths(spec("Kerf Sabre", "dejavu-mono")));
    expect(bold.maxX).toBeGreaterThan(regular.maxX);
    expect(mono.maxX).not.toBeCloseTo(regular.maxX, 1);
  });

  it("quadratic and cubic contours come out as lines and cubics only", () => {
    for (const p of textToPaths(spec("Sg@"))) for (const s of p.segs) expect(["l", "c"]).toContain(s.t);
  });

  it("kerning pulls AV closer than A+V laid out separately", () => {
    const together = union(textToPaths(spec("AV"))).maxX;
    const a = union(textToPaths(spec("A"))).maxX;
    const v = union(textToPaths(spec("V")));
    expect(together).toBeLessThan(a + (v.maxX - v.minX) + 2);
  });

  it("returns nothing for empty text, a bad size or an unknown font", () => {
    expect(textToPaths(spec(""))).toEqual([]);
    expect(textToPaths(spec("A", "dejavu-sans", 0))).toEqual([]);
    expect(textToPaths(spec("A", "no-such-font"))).toEqual([]);
  });
});

describe("single-line text", () => {
  it("draws open stroke paths made only of lines, with a similar cap height", () => {
    const paths = textToPaths(spec("H", "hershey-futural", 10));
    expect(paths.length).toBe(3); // two stems and a bar
    expect(paths.every((p) => !p.closed && p.segs.every((s) => s.t === "l"))).toBe(true);
    const b = union(paths);
    expect(b.minY).toBeCloseTo(0, 1);
    expect(b.maxY).toBeCloseTo(7.29, 1);
  });

  it("closed loops stay closed, and text advances left to right", () => {
    expect(textToPaths(spec("O", "hershey-futural")).some((p) => p.closed)).toBe(true);
    const one = union(textToPaths(spec("I", "hershey-futural")));
    const two = union(textToPaths(spec("II", "hershey-futural")));
    expect(two.maxX).toBeGreaterThan(one.maxX + 1);
  });

  it("every single-line font renders printable ASCII without throwing", () => {
    for (const f of listFonts().filter((x) => x.kind === "single"))
      expect(textToPaths(spec("The quick brown fox 0123456789 !?&@", f.id)).length).toBeGreaterThan(10);
  });
});

describe("Doc text objects", () => {
  const make = () => {
    const d = new Doc();
    const s = spec("Hi");
    const paths = textToPaths(s);
    const textId = d.addText(s, paths, translation(40, 50), "cut");
    return { d, textId, s };
  };

  it("adds one grouped contour object per contour, all tagged with the text id", () => {
    const { d, textId } = make();
    const members = d.textMembers(textId);
    expect(members.length).toBe(textToPaths(spec("Hi")).length);
    expect(new Set(members.map((id) => d.get(id)!.group)).size).toBe(1);
    expect(d.get(members[0]!.valueOf())!.group).toBeDefined();
    expect(d.state.texts[textId]!.content).toBe("Hi");
  });

  it("retext replaces the contours but keeps placement, layer and group", () => {
    const { d, textId } = make();
    const before = d.get(d.textMembers(textId)[0]!)!;
    const { group } = before;
    d.transform(before.id, translation(5, 5)); // placement now (45,55) on that member
    for (const id of d.textMembers(textId)) if (id !== before.id) d.transform(id, translation(5, 5));
    d.setLayer(d.textMembers(textId), "score");
    const next = spec("Hello", "dejavu-serif", 20);
    const ids = d.retext(textId, next, textToPaths(next));
    expect(ids.length).toBe(textToPaths(next).length);
    const first = d.get(ids[0]!)!;
    expect(first.matrix.slice(4)).toEqual([45, 55]);
    expect(first.layer).toBe("score");
    expect(first.group).toBe(group);
    expect(d.state.texts[textId]).toEqual(next);
    expect(d.state.objects.length).toBe(ids.length); // old contours are gone
  });

  it("convert to path keeps the contours, drops the editable text", () => {
    const { d, textId } = make();
    const count = d.state.objects.length;
    d.convertText([d.textMembers(textId)[0]!]);
    expect(d.state.objects.length).toBe(count);
    expect(d.state.objects.every((o) => o.textId === undefined)).toBe(true);
    expect(d.state.texts[textId]).toBeUndefined();
  });

  it("undo restores the previous text", () => {
    const { d, textId } = make();
    d.checkpoint();
    const next = spec("Bye");
    d.retext(textId, next, textToPaths(next));
    expect(d.state.texts[textId]!.content).toBe("Bye");
    d.undo();
    expect(d.state.texts[textId]!.content).toBe("Hi");
    expect(d.state.objects.length).toBe(textToPaths(spec("Hi")).length);
  });
});
