# Shared Packages

`packages/` contains reusable product code that is safe to import from the desktop and CLI Python runtimes.

Current package:

- `shared_core`: media classification, source-language configuration, Gladia job resume, long-audio splitting/merging, rendering, key management, and desktop/CLI pipeline orchestration.

## Boundary Rules

- New desktop and Python CLI business logic should use `packages/shared_core`.
- `apps/desktop/main.py` owns PyQt UI and desktop-only state.
- The Vercel web product uses cloud-safe Node/Python modules under `apps/web/api`; it does not import PyQt, packaged runtime paths, or the desktop cache implementation.
- Domain behavior shared conceptually by desktop and web must have matching tests on both sides, even when serverless constraints require separate implementations.
- Root-level `core/` and `app/` imports remain compatibility wrappers only.

See [`../docs/REPO_BOUNDARIES.md`](../docs/REPO_BOUNDARIES.md) and [`../docs/CURRENT_STATE_ZH.md`](../docs/CURRENT_STATE_ZH.md).
