# Kerf as a product: decisions and plan

Owner: **mr-salih.org** (Leroy Salih). Kerf was built on his own time with his own Claude subscription; the intellectual property is his.

## Decisions (made by the owner)

| # | Decision | What it means for the code |
|---|---|---|
| 0 | **The IP belongs to mr-salih.org.** | No school's name in the product (done in shared 0.2.31). A school's names, lasers and settings are customer configuration. |
| 1 | **Hosted only.** Kerf Server runs as one service run by mr-salih.org; schools subscribe. No self-hosted edition. | No licence keys or installer for the Server. One multi-school deployment (the per-school walls already exist). Operations (Postgres, migrations, backups, monitoring, staging, releases) are ours to run. |
| 2 | **Schools pay per school** (a flat subscription per school). | Billing and limits are per school: `School` gets a plan and a subscription status. No per-station or per-pupil counting is needed for billing (sensible caps for abuse are still allowed). Invoices and purchase orders must be possible, not only cards. |
| 4 | **One code base.** BISAK runs exactly the same code as every other school: it is one customer (one school) on the same hosted Kerf, configured, never forked. | No school-specific branches, builds or `if school == ...` code. Anything BISAK needs that others may not (DINO sign-in, its lasers, its materials) is a per-school setting or integration that any school could switch on. |
| 5 | **Schools sign themselves up.** A teacher registers their school and becomes its first admin, then adds teachers and pupils. | Self-service signup with email verification, then onboarding (lasers, materials, classes). Per-school sign-in methods: a school without single sign-on needs Kerf's own accounts; BISAK keeps DINO as its school's sign-in method. |
| 6 | **Two admin sites; groups and pupils from many sources.** A separate Platform site for the site admin only; today's Admin site becomes the School Admin site. Groups by hand, CSV or a provider (DINO, Google, Microsoft); pupils by provider, CSV or group code + pupil ID + password; Google and Microsoft are off until a school admin turns them on. | Design in `docs/ACCOUNTS.md`: per-school sign-in methods, people with linked identities, groups with a source. |
| 7 | **Free tools first.** The first public release offers only the free tools (free schools register instantly); no paid Server option is offered yet. Paid schools are approved by the site admin (BISAK is one). | Paid features (queue, lasers, Cutter, Station pages, camera) stay behind a per-school plan switch set by the site admin; nothing in the free release can turn them on. |
| 3 | **The Editor is free and open source under the GNU AGPL-3.0** (`AGPL-3.0-only`). **Kerf Server and Kerf Cutter are closed (proprietary, all rights reserved).** | The design Editor is published in a public repository under an open-source licence and works with no server. The Server, Cutter and the paid screens stay closed. |

## Consequences of decision 3 (open-source Editor)

- **One repository, published Editor mirror.** Development stays in this one private repository (decision 4). The public Editor repository is a **read-only mirror generated from it** (for example a `git subtree split` of the open Editor files, pushed by CI on each release), never a separate code base. The paid screens first move out of `editor/` (to the Server's own web app) so that what is mirrored is exactly the open part.
- **What is open and what is not.** Open: the design Editor (drawing, import, tools, DXF/SVG export, file tabs, local saving) and the shared file formats it reads and writes (`job.schema.json`, `preset.schema.json`). Closed (paid, served by Kerf Server): the Admin site (`editor/src/admin/`), Station mode and the camera, calibration and alignment screens (`stationui.ts`, `calibrateui.ts`, `alignui.ts`), and sign-in, sending and the queue (the Editor talks to a server only through the public API in `shared/openapi.yaml`).
- **Machine profiles** are currently built into the Editor from `shared/machine-profiles` (one school's lasers). The open Editor needs a "my laser" setting (bed size already exists) and generic materials; a signed-in user gets their school's lasers and materials from the server.
- **Licences of what the Editor bundles** must fit the chosen licence: paper.js (MIT), opentype.js (MIT), clipper-lib (Boost), DejaVu fonts (free licence), Hershey fonts (MIT), and **esm-potrace-wasm (GPL-2.0, image tracing in `src/imagetrace.ts`)**. Potrace's GPL means the Editor must either use a GPL-family licence or replace image tracing with a permissively licensed tracer before release.
- **Licence files:** `editor/LICENSE` (AGPL-3.0 text), `editor/LICENSING.md` (what it covers, the proprietary service screens still in `editor/` until the split, third-party licences), `server/LICENSE` and `cutter/LICENSE` (proprietary); the Cutter zip and the practice Cutter zip carry a `LICENSE.txt`.
- **Before publishing:** confirm Potrace (`esm-potrace-wasm`, declared `GPL-2.0`) may be used under "GPL-2.0 or later" (needed to combine it with AGPL-3.0), or replace image tracing.

## Open questions

1. ~~Editor licence~~: decided, AGPL-3.0. Open: the licence of `shared/` (the job and preset schemas and the API contract the open Editor uses): publish them with the Editor (AGPL) or under a permissive licence so other tools can read Kerf files.
2. **Product name and domain.** "Kerf" is a common laser-cutting word: check trademarks and a free domain before launch.
3. **Price and what is in the plan** (stations, printers, camera alignment, support level).
4. **Sign-in for other schools:** Google Workspace and Microsoft 365 (OpenID Connect) alongside DINO; email links or class code + PIN for schools without single sign-on.

## Plan (in order)

1. Settle the Potrace question; move the paid screens out of `editor/`; publish the open Editor as a mirror of this repository (design Editor only, no school specifics, works offline, "my laser" settings).
2. Per-school sign-in (Google, Microsoft, DINO; mapping users to schools), self-service school signup and onboarding (first admin, lasers, materials).
3. Billing per school (Stripe or Paddle, with invoices/POs), plan status enforced by the Server (a lapsed subscription never stops a cut in progress).
4. Operations: PostgreSQL, real migrations (Alembic), CI for every component, a staging server, monitoring and error reporting without pupil data, tested backups, a status page; live Cutter connections and other in-memory state made safe for more than one server process.
5. Legal: terms of service (including laser safety and supervision), privacy notice, a data processing agreement for schools (children's data: UK/EU GDPR and the Children's Code), data location, retention and deletion.
6. Kerf Cutter: signed Windows build, auto-update, a supported-hardware list.
7. Pilot with two or three schools, then launch.
