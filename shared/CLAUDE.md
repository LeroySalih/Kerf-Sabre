# shared/ rules
- Every schema has a `schemaVersion` (semver). Any change bumps the version and adds a `CHANGELOG.md` entry.
- No silent breaking changes: breaking = major bump, with a migration note.
- Units mm; bed-space coordinates Y-up; no pupil names anywhere, pupil IDs only.
- Placeholder machine profiles are marked `"placeholder": true` until replaced from spike results.
- Validate examples in `shared/tests` (`pytest shared/tests`).
