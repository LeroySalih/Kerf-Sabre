// opentype.js 2.x ships no types; this declares only what the editor uses.
declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "C" | "Q" | "Z";
    x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  }
  export interface Glyph {
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): { commands: PathCommand[] };
  }
  export interface Font {
    unitsPerEm: number;
    charToGlyph(c: string): Glyph;
    getKerningValue(a: Glyph, b: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
