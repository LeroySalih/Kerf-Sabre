# Licensing of the Kerf Editor

Copyright (C) 2026 mr-salih.org (Leroy Salih).

## The design Editor: GNU AGPL-3.0

The Kerf design Editor is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** (`LICENSE` in this folder; SPDX `AGPL-3.0-only`).
It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the licence for details.

If you run a modified version of the Editor for other people over a network, the AGPL requires you to offer
them its source code.

## Not covered: the Kerf service screens (proprietary)

These files are part of the paid Kerf service, not of the open Editor. They are **not** licensed under the
AGPL; they are proprietary to mr-salih.org (all rights reserved) and will move out of this folder when the
open Editor is published in its own repository:

- `src/admin/` and `admin/` (the Kerf Admin site)
- `src/stationui.ts`, `src/stationlogic.ts` (Station mode at the laser)
- `src/calibrateui.ts`, `src/alignui.ts`, `src/alignlogic.ts`, `src/homography.ts`, `src/camerafeed.ts`
  (camera calibration and alignment)
- `site/` and `src/site/` (Kerf's public website: the landing page, `/pricing` and the `/sign-in` page), and the
  `kerf-site-*` plugins in `vite.config.ts`. The website's fonts, Lexend and Atkinson Hyperlegible, are bundled from the
  `@fontsource/lexend` and `@fontsource/atkinson-hyperlegible` packages under the SIL Open Font License 1.1 (only the
  website uses them; the Editor does not)

Until that split, nothing from this folder is published.

## Third-party components bundled with the Editor

| Component | Licence | Used for |
|---|---|---|
| paper.js | MIT | geometry |
| opentype.js | MIT | outline fonts |
| clipper-lib | Boost Software License 1.0 | offsets |
| esm-potrace-wasm (Potrace) | GPL-2.0 | image tracing (`src/imagetrace.ts`) |
| DejaVu fonts | DejaVu fonts licence (`public/fonts/DEJAVU-LICENSE.txt`) | text |
| Hershey fonts via hersheytext | MIT (`src/fonts/HERSHEYTEXT-LICENSE.txt`) | single-line text |
| Lexend, Atkinson Hyperlegible (Fontsource) | SIL Open Font License 1.1 (`node_modules/@fontsource/*/LICENSE`) | the website only (not the Editor) |

**Open item before publishing:** GPL-2.0 code can only be combined with AGPL-3.0 code if it is licensed
"GPL-2.0 *or later*". Upstream Potrace is understood to be "version 2 or later", but `esm-potrace-wasm`
declares plain `GPL-2.0`. Confirm "or later" with its author, or replace image tracing with a tracer under a
compatible licence, before the Editor is released.
