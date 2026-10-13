# editor/ (BISAK Kerf Editor)
TypeScript PWA for Chrome/Edge desktop. paper.js for geometry, opentype.js for text. Internal units mm; Design/Bed/Screen/Camera spaces per brief section 5; Bed→Screen conversion lives in ONE function. Edits change object matrices, never source geometry. Export DXF/SVG must work standalone. Does not talk to hardware directly (no Web Serial).

## Commands (run from `editor/`)
- `npm install`, `npm run dev` (Vite dev server), `npm run build` (typecheck + bundle), `npm test` (vitest), `npm run typecheck`.
- Machine profiles are imported from `../shared/machine-profiles` at build time (`src/machine.ts`).
- `src/coords.ts` holds Bed<->Screen conversion; do not convert elsewhere. `public/sw.js` is the offline app-shell cache.
