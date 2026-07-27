# Web App

This directory is the web product surface for `video2text`.

Current scope:

- static web shell
- Python API endpoints for health and capability introspection
- request schema placeholder for future cloud transcription
- Vercel deployment root for the web surface only

Current boundaries:

- desktop packaging must not read from `apps/web`
- web deployment must not read from `release/`
- shared constants and pipeline-facing capabilities should come from `packages/shared_core` where possible

Current entrypoints:

- static page: `apps/web/index.html`
- local helper server: `apps/web/dev_server.py`
- API endpoints:
  - `apps/web/api/health.py`
  - `apps/web/api/capabilities.py`
  - `apps/web/api/transcribe.py`
