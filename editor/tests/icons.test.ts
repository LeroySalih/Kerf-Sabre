import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "../src/icons";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("icon set", () => {
  it("every icon is non-empty, well-formed SVG markup", () => {
    for (const [name, body] of Object.entries(ICONS)) {
      expect(body.length, name).toBeGreaterThan(10);
      expect(body, name).not.toMatch(/<script|on\w+=/i);
      const open = (body.match(/<[a-z]+[\s>]/g) ?? []).length;
      const closed = (body.match(/\/>|<\/[a-z]+>/g) ?? []).length;
      expect(closed, `${name}: unbalanced tags`).toBe(open);
    }
  });

  it("every <use href> in the page refers to an icon that exists", () => {
    const used = [...html.matchAll(/<use href="#i-([\w-]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const name of used) expect(ICONS[name], `missing icon: ${name}`).toBeDefined();
  });

  it("every icon is used somewhere, so nothing is dead weight", () => {
    for (const name of Object.keys(ICONS)) expect(html, `unused icon: ${name}`).toContain(`#i-${name}"`);
  });

  it("every toolbar button that carries an icon also has a tooltip and an accessible name", () => {
    const buttons = [...html.matchAll(/<button[^>]*>\s*<svg class="ico"><use href="#i-[\w-]+"\/><\/svg>\s*<\/button>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThan(20);
    for (const b of buttons) {
      expect(b, b).toMatch(/title="[^"]+"/);
      expect(b, b).toMatch(/aria-label="[^"]+"/);
    }
  });
});
