# cutter/ (BISAK Kerf Cutter)
Spike gate met (all four station PCs pass; see `docs/spike-results.md`). The plan is `cutter/PLAN.md`; read it and `docs/spike-results.md` before non-trivial work. Build in milestone order (M0 first).

Rules: portable-folder deployment, JSON-lines logging with raw serial TX/RX, rotating local logs, diagnostic bundle, outbound-only connection, feed hold + reset on any fault. Read `$30`, never assume. Never `G92`. Device (COM port and camera) selection is stored as match rules and managed explicitly, never hard-coded. Own folder only; `shared/` changes need a version bump and a `shared/CHANGELOG.md` entry, one feature at a time.

Tests: `pytest` from `cutter/` against the simulated GRBL in `tests/fake_grbl.py`.
