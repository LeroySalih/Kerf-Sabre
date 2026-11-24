# Kerf accounts, sign-in and the two admin sites (design)

Status: **design agreed with the owner; being built in steps** (built so far: plans and school codes, per-school sign-in methods, groups with several pupils and join codes, the configurable terms). Open questions at the end. One code base (PRODUCT.md decision 4): every school, BISAK included, uses exactly this.

## Two admin sites

| Site | Who | What |
|---|---|---|
| **Kerf Platform** (a separate site, e.g. `/platform/`) | Only the site admin(s) of mr-salih.org (the owner's own account; listed in server settings, never a school role) | All schools: create, suspend, look up; subscription and plan; usage; the Kerf-wide sign-in providers (Google, Microsoft, DINO client registrations); support access to a school (logged, time-limited); server health. Sees school settings and counts, not pupils' work. |
| **School Admin** (today's Admin site) | A school's admins and teachers (technicians: Station pages only, as now) | Everything inside one school: staff, groups, pupils, sign-in methods, lasers, materials, queue, activities. |

The Editor and Station pages are unchanged by this split.

## Sign-in methods (per school)

Each school has its own list of methods, switched on by its school admin:

| Method | For | Default for a new school |
|---|---|---|
| **DINO** (planner-004) | staff and pupils | off (on for BISAK) |
| **Google** (OpenID Connect; optionally limited to the school's Google Workspace domain) | staff and pupils | **off**: a school admin turns it on |
| **Microsoft** (Entra ID / Microsoft 365; optionally limited to the school's tenant) | staff and pupils | **off**: a school admin turns it on |
| **Group code + pupil ID + password** | pupils | on |
| **Kerf account** (email and a sign-in link) | staff, so a school can start before any single sign-on is set up | on |

Google, Microsoft and DINO are registered once for all of Kerf by the site admin (one client ID each); a school only switches them on and says which domain or tenant is its own. A person signing in with a provider is matched to their school by that domain/tenant or by an existing link; nobody joins a school just by having a Google account.

## Groups (today's "classes")

A teacher can make a group:
- **by hand** (name, then add pupils);
- **from a CSV** (group name, pupil ID, optionally display name);
- **from a provider**: DINO groups (exists: `GET /groups`, shared 0.2.30), Google Classroom courses, Microsoft Teams/Entra classes. Importing links the group to the provider's group so it can be refreshed.

Every group has a **group code** (as class codes today) that a teacher can show full screen.

## Pupils

A pupil gets into a school by one of:
- **import from a provider** (DINO, Google, Microsoft) with their group;
- **CSV upload**;
- **group code**: on the sign-in screen the pupil types the group code (shown on the board), their pupil ID and their password.

A pupil may sign in with any method linked to their account (e.g. group code at school, Google at home), once the school has that method on.

## Data model changes (outline)

- `Person`: one row per human per school (internal id, role(s), display name, school). Today a pupil ID or DINO `sub` doubles as the id; it becomes a **linked identity**.
- `Identity`: (provider, subject) -> person, e.g. (`dino`, sub), (`google`, sub), (`microsoft`, oid), (`kerf-group`, group code + pupil ID). Unique per provider.
- `SchoolAuth`: per school, which methods are on, and the Google domain / Microsoft tenant / DINO issuer that belong to it.
- `Group` (today `SchoolClass`) gains `source` (manual, csv, dino, google, microsoft) and the provider's group id.
- Pupil password: stored hashed (scrypt, as PINs today), with lockout and throttling (the class-login code already does this).
- BISAK migrates in place: its DINO pupils and staff become persons with a `dino` identity; DINO is switched on for BISAK only.

## Answers (owner, 2026-11)

1. **The site admin signs in to the Platform site with their DINO account** (their DINO ID is listed as a site admin in the server's settings; no separate password).
2. **Group-code passwords are issued by the teacher**; pupils cannot create their own accounts. A **Pupil Cards** page makes this super simple: pick a group, print one small card per pupil (school name, group code, pupil ID, password, how to sign in), and a full-screen view of the group code for the board. A password is shown on cards only when it is made or reset, never again.
3. **Staff use an email sign-in link** until their school turns on Google, Microsoft or DINO.

## More answers (owner, 2026-11-23)

- **Roll-out: free tools first.** No paid Server option is offered publicly yet. **Free schools register instantly**; a **paid school is approved by the site admin** (BISAK is the existing paid school).
- **Group join codes:** Kerf generates one by default; the teacher may type their own when making the group (by hand or in the CSV), and may edit it later. **Unique within a school.**
- **Pupil passwords:** Kerf's default is **two words** (e.g. `tiger-river`); the teacher reissues them (new card); pupils do not choose or change them.
- **Pupils can be in several groups**, and a group can be **re-synced from its source** (e.g. DINO).
- **Display names:** teachers may enter them; they are **printed on the Pupil Cards** (staff and the pupil's own card only, never in logs).
- **Signing in without an import** (e.g. Google): the pupil is asked to **join** and waits; a teacher **approves** them from the group's page.
- **Staff:** a school can have **several admins**; **only admins invite teachers** (and technicians, admins).
- **Support access:** the school turns on **"Allow support access"** on its own page before the site admin can enter it through Kerf; failing that, the site admin can **email the school's admins an access request link**. All support access is logged.
- **Leaving:** pupils are **archived** (soft-deleted, cannot sign in) and **can be deleted** permanently. A **group can be renamed** (moving up a year) **or archived**.

## Free and paid (owner, 2026-11-23)

| Free school | Paid school (approved by the site admin) |
|---|---|
| The Editor; pupil and staff accounts; groups; Pupil Cards; files saved to Kerf; **teacher merges pupils' files** into one file | Everything free, plus **activities and teacher feedback, approval, laser connection (Kerf Cutter), the queue, Station pages, the camera** |

- **Limits for a free school:** 20 files per pupil, 20 groups per school, 50 pupils per group. Generous but firm; the server enforces them and says which limit was reached.
- The teacher's merge of pupils' files must work from pupils' **saved files** (a free school has no queue).
- **The camera features need a review** before they are sold (owner's note).
- **School code:** every school has a short school code. Group-code sign-in is **school code + group code + pupil ID + password**. No QR codes.
- **Pupil IDs** follow the group-code rule: Kerf makes one, the teacher may type their own (by hand or in the CSV), unique within the school.
- **Email** is sent from `kerf-no-reply@mr-salih.org`.
- **Re-sync** from a source removes a pupil from the group only (account and files kept) and shows the changes for the teacher to confirm first.
- **Permanent delete** of an archived pupil: school admins only, and logged. Removing a pupil from their last group only archives them (built, shared 0.2.36); nothing removes a pupil for good except that explicit delete.
- **BISAK** keeps every paid feature as an approved paid school.

## Terms: a configurable free tier (owner, 2026-11-24; built, shared 0.2.35)

The owner's point: a free tier with no laser saves a school per-pupil licences but not the teacher's work (they still
export pupils' files to the laser). Sending files straight to the laser is the feature that matters, so the free tier
may include it for a limited number of groups or for a while, and the site admin decides.

- **Terms** = features (`laser`: queue, approval, sending, Station pages, camera; `activities`) + limits (groups per school,
  pupils per group, files per pupil, **laser groups**) + **grants** (extras for a while). Examples: "3 months of everything"
  (a grant: 3 months, laser + activities, no group limit); "10 groups on the laser for 12 months" (a grant: 12 months,
  laser, laser groups 10).
- The site admin sets **Kerf's default terms** (Platform > Default terms) and can change **one school's** terms (Platform >
  Schools > Terms…).
- **When a school registers, the default is copied to it**, grant months becoming dates; later changes to the default never
  touch it. Free schools that existed before terms got a copy of the default at start-up.
- A **paid** school has everything with no limits (terms do not apply).
- While laser groups are limited, a **school admin picks** which groups send to the laser (Classes > Laser group). A pupil
  in none of them is told to ask their teacher.
- When a grant ends, its features and raised limits stop at once: nothing is deleted (groups over a limit stay; no new
  ones), and files already in the queue wait until the laser is back on the plan.
- Built-in default until the site admin changes it: the free tools, 20 groups, 50 pupils per group, 20 files per pupil,
  no grants.

## Remaining questions

- (answered: email goes through **Resend**; the key is `RESEND_API` in the production `.env`.)
- Terms: should a school see a warning before a grant ends (e.g. 14 days ahead, by email to its admins)?
