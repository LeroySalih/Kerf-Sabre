# Kerf accounts, sign-in and the two admin sites (design)

Status: **design agreed with the owner in outline; open questions at the end; not built yet.** One code base (PRODUCT.md decision 4): every school, BISAK included, uses exactly this.

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

## Open questions

1. How does the site admin sign in to the Platform site (DINO account, a Kerf account, or Google)?
2. Group-code sign-in: does the teacher issue each pupil's password (shown once, like PINs before), or may a pupil with the group code create their own account (pick their ID and password), waiting for the teacher to approve?
3. Staff at a brand-new school: Kerf account by email link (proposed), until the school turns on Google, Microsoft or DINO?
