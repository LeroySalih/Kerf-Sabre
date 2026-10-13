# editor/ (BISAK Kerf Editor)
TypeScript PWA for Chrome/Edge desktop. paper.js for geometry, opentype.js for text. Internal units mm; Design/Bed/Screen/Camera spaces per brief section 5; Bed→Screen conversion lives in ONE function. Edits change object matrices, never source geometry. Export DXF/SVG must work standalone. Does not talk to hardware directly (no Web Serial).

## Commands (run from `editor/`)
- `npm install`, `npm run dev` (Vite dev server), `npm run build` (typecheck + bundle), `npm test` (vitest), `npm run typecheck`.
- Machine profiles are imported from `../shared/machine-profiles` at build time (`src/machine.ts`).
- `src/coords.ts` holds Bed<->Screen conversion; do not convert elsewhere. `public/sw.js` is the offline app-shell cache.

## Modules
- `geometry.ts` (segments/matrices/shapes), `select.ts` (box select), `anchor.ts` (3x3 anchor, numeric X/Y position and W/H resize about the anchor), `doc.ts` (objects + undo/redo), `export.ts` (DXF/SVG), `dxf-import.ts` (LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE), `main.ts` (UI).
- Import only converts and normalises (units -> mm; a file with no `$INSUNITS` is assumed to be centimetres, the Onshape default; bbox bottom-left -> 0,0). Dedupe/merge/join clean-up is Server work. Unsupported entities (TEXT, HATCH, ELLIPSE...) are counted and reported, not imported.
- Groups are a `group` id on `DocObject` (one level; grouping again merges). Selection and moves always go through `Doc.expand()` so group members act together. The 1 cm grid is drawn by `drawGrid` in `main.ts` (toggle in the toolbar).
