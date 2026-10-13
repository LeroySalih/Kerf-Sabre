// The tool icon set: 24x24, drawn with currentColor strokes so they follow the button colour.
// Each entry is the inner markup of an SVG <symbol>. Used as <svg class="ico"><use href="#i-NAME"/></svg>.
export const ICONS: Record<string, string> = {
  // ---- draw ----
  select: '<path d="M6 3.5l12 8.6-5.4 1.3L9.8 19z"/>',
  pen: '<path d="M4 20l1-4.2L16.3 4.5a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.2 19z"/><path d="M14.5 6.3l3.2 3.2"/>',
  rect: '<rect x="4" y="6.5" width="16" height="11" rx="1"/>',
  rrect: '<rect x="4" y="6.5" width="16" height="11" rx="4.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  star: '<path d="M12 3.5l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6-4.5-4.2 6.1-.8z"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  polygon: '<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/>',
  line: '<path d="M5.5 18.5L18.5 5.5"/><circle cx="5.5" cy="18.5" r="1.4"/><circle cx="18.5" cy="5.5" r="1.4"/>',
  text: '<path d="M5 19L11 5h2l6 14M7.7 14h8.6"/>',
  // ---- edit ----
  trim: '<circle cx="6.5" cy="7" r="2.4"/><circle cx="6.5" cy="17" r="2.4"/><path d="M8.6 8.3L20 17.5M8.6 15.7L20 6.5"/>',
  radius: '<path d="M5 20v-8.5A6.5 6.5 0 0 1 11.5 5H20"/><path d="M5 20h2M17 5v0" stroke-dasharray="1 0"/>',
  "round-all": '<rect x="4.5" y="4.5" width="15" height="15" rx="5"/>',
  nodes: '<path d="M4 18c3-9 8-12 16-9"/><rect x="2.2" y="16.2" width="3.6" height="3.6" fill="currentColor"/><rect x="18.2" y="7.2" width="3.6" height="3.6" fill="currentColor"/><rect x="10" y="8.4" width="3.4" height="3.4" fill="#fff"/>',
  join: '<path d="M3 12h7M14 12h7"/><path d="M8 9l3 3-3 3M16 9l-3 3 3 3"/>',
  "close-path": '<path d="M5 18V8l7-4 7 4v10"/><path d="M5 18h14" stroke-dasharray="2 2.5"/>',
  explode: '<path d="M5 6h8M18 8v8M16 19H8M6 17V9"/>',
  tab: '<path d="M4 18V6h5M15 6h5v12H4"/><path d="M9 3.5v5M15 3.5v5"/>',
  "tabs-auto": '<path d="M4 8V4h5M13 4h7v5M20 13v7h-5M11 20H4v-5"/>',
  measure: '<g transform="rotate(-35 12 12)"><rect x="2" y="8.5" width="20" height="7" rx="1"/><path d="M6 8.5v3M9.5 8.5v2M13 8.5v3M16.5 8.5v2M20 8.5v3" /></g>',
  gimbal: '<circle cx="12" cy="12" r="1.8"/><path d="M12 10.2V3.8M9.9 5.9L12 3.8l2.1 2.1M13.8 12h6.4M18.1 9.9l2.1 2.1-2.1 2.1"/><path d="M7.2 16.8a6.5 6.5 0 0 0 9.6 0"/>',
  // ---- boolean ----
  union: '<path d="M4 4h10v6h6v10H10v-6H4z" fill="currentColor" fill-opacity=".18"/>',
  intersect: '<rect x="4" y="4" width="10" height="10" opacity=".5"/><rect x="10" y="10" width="10" height="10" opacity=".5"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/>',
  subtract: '<path d="M4 4h10v6h-4v4H4z" fill="currentColor" fill-opacity=".18"/><rect x="10" y="10" width="10" height="10" stroke-dasharray="2 2" opacity=".6"/>',
  // ---- arrange ----
  group: '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.5"/><rect x="7" y="7" width="4.6" height="4.6"/><rect x="12.4" y="12.4" width="4.6" height="4.6"/>',
  ungroup: '<rect x="3.5" y="3.5" width="7" height="7"/><rect x="13.5" y="13.5" width="7" height="7"/><path d="M12.4 9.6l1.2-1.2M8.4 14.4l-1.2 1.2" stroke-dasharray="1.5 1.5" opacity=".7"/>',
  "flip-h": '<path d="M12 3v18" stroke-dasharray="2 2.4"/><path d="M9.6 7L4 18h5.6z" fill="currentColor" fill-opacity=".2"/><path d="M14.4 7L20 18h-5.6z"/>',
  "flip-v": '<path d="M3 12h18" stroke-dasharray="2 2.4"/><path d="M7 9.6L18 4v5.6z" fill="currentColor" fill-opacity=".2"/><path d="M7 14.4L18 20v-5.6z"/>',
  // ---- align ----
  "align-left": '<path d="M4 3v18"/><rect x="7" y="6" width="13" height="4"/><rect x="7" y="14" width="7" height="4"/>',
  "align-centre": '<path d="M12 3v18"/><rect x="4.5" y="6" width="15" height="4"/><rect x="8" y="14" width="8" height="4"/>',
  "align-right": '<path d="M20 3v18"/><rect x="4" y="6" width="13" height="4"/><rect x="10" y="14" width="7" height="4"/>',
  "align-top": '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="13"/><rect x="14" y="7" width="4" height="7"/>',
  "align-middle": '<path d="M3 12h18"/><rect x="6" y="4.5" width="4" height="15"/><rect x="14" y="8" width="4" height="8"/>',
  "align-bottom": '<path d="M3 20h18"/><rect x="6" y="4" width="4" height="13"/><rect x="14" y="10" width="4" height="7"/>',
  "space-h": '<path d="M3.5 4v16M20.5 4v16"/><rect x="9.5" y="8" width="5" height="8"/><path d="M5.5 12h2.5M16 12h2.5" opacity=".6"/>',
  "space-v": '<path d="M4 3.5h16M4 20.5h16"/><rect x="8" y="9.5" width="8" height="5"/><path d="M12 5.5v2.5M12 16v2.5" opacity=".6"/>',
  // ---- repeat ----
  "linear-repeat": '<rect x="3" y="4" width="5" height="5"/><rect x="9.5" y="4" width="5" height="5" opacity=".6"/><rect x="16" y="4" width="5" height="5" opacity=".6"/><rect x="3" y="11" width="5" height="5" opacity=".6"/><rect x="9.5" y="11" width="5" height="5" opacity=".6"/><rect x="16" y="11" width="5" height="5" opacity=".6"/>',
  "circular-array": '<circle cx="12" cy="12" r="7" stroke-dasharray="2 2.5" opacity=".6"/><rect x="9.8" y="2" width="4.4" height="4.4"/><rect x="17.6" y="9.8" width="4.4" height="4.4" opacity=".6"/><rect x="9.8" y="17.6" width="4.4" height="4.4" opacity=".6"/><rect x="2" y="9.8" width="4.4" height="4.4" opacity=".6"/>',
};

/** Inject the icons once as a hidden SVG sprite, so any `<use href="#i-NAME">` resolves. */
export function mountIcons(doc: Document = document): void {
  if (doc.getElementById("icon-sprite")) return;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "icon-sprite";
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.innerHTML = `<defs>${Object.entries(ICONS).map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`).join("")}</defs>`;
  doc.body.prepend(svg);
}
