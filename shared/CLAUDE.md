# shared/ rules
- Every schema has a `schemaVersion` (semver). Any change bumps the version and adds a `CHANGELOG.md` entry.
- No silent breaking changes: breaking = major bump, with a migration note.
- Units mm; bed-space coordinates Y-up; no pupil names anywhere, pupil IDs only.
- Machine profiles carry the values measured in the spike (`docs/spike-results.md`); a profile with unmeasured values is marked `"placeholder": true`. `originCorner` and `model` are still assumed / unknown.
- Validate examples in `shared/tests` (`pytest shared/tests`).
