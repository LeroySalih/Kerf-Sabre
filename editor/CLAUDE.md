# editor/ (BISAK Kerf Editor)
TypeScript PWA for Chrome/Edge desktop. paper.js for geometry, opentype.js for text. Internal units mm; Design/Bed/Screen/Camera spaces per brief section 5; Bed→Screen conversion lives in ONE function. Edits change object matrices, never source geometry. Export DXF/SVG must work standalone. Does not talk to hardware directly (no Web Serial).
