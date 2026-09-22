# Repository Boundaries

> Updated: 2026-09-22

## Purpose

This repository contains two deployed product surfaces with shared domain rules but different runtime implementations:

- Windows desktop application;
- Vercel web application.

They must not share deployment scripts, runtime folders, credentials, or release artifacts directly.

## Surface Ownership

### Desktop

- product entry and implementation: `apps/desktop/main.py`
- reusable pipeline: `packages/shared_core/`
- helper and legacy scripts: `outputs/work/`
- build script: `scripts/desktop/build_release.ps1`
- packaged output: `release/video2text/video2text/`
- source runtime config/cache: repository `config/` and `outputs/work/jobs/`
- EXE runtime config/cache: `<exe-folder>/config/` and `<exe-folder>/outputs/work/jobs/`

### Web

- source root: `apps/web/`
- static production files: `apps/web/public/`
- serverless API: `apps/web/api/`
- deploy config: `apps/web/vercel.json`
- package manifest: `apps/web/package.json`
- cloud storage: Vercel Blob media, job checkpoints, and results
- production translation provider: MiniMax M3

The web implementation deliberately duplicates a small amount of domain logic, including cloud-safe long-audio planning and result merging. It cannot import the desktop PyQt/PyInstaller runtime into Vercel Node/Python functions.

### Compatibility And Historical Code

- `app/` and `core/` are migration compatibility wrappers, not primary implementation homes.
- `outputs/work/run_all_win.py`, `run_zh_pipeline.py`, and related DeepL scripts belong to the historical batch subtitle workflow.
- The historical DeepL workflow remains available for old jobs but is not the current desktop GUI or Web translation path.

### Documentation

- `README.md`: user-facing entry and common commands;
- `docs/CURRENT_STATE_ZH.md`: authoritative implemented status;
- `docs/PACKAGING_AND_DEPLOY.md`: build/deploy operations;
- `docs/LONG_TEXT_TRANSLATION_BENCHMARK_ZH.md`: model test evidence and product decision;
- `docs/CLOUD_STORAGE_ALTERNATIVE_ZH.md`: unimplemented R2/Ubuntu alternative.

## Rules

- New desktop features enter through `apps/desktop` and `packages/shared_core`.
- New web features stay deployable from `apps/web` alone.
- Do not point Vercel at the repository root.
- Do not include `apps/web/node_modules`, Blob data, `.env.local`, or web runtime state in desktop releases.
- Do not point PyInstaller at web assets or dependencies.
- Do not commit real `config/*.json`, API keys, `.env`, `build/`, or `release/`.
- Preserve final user TXT/SRT outside cache cleanup paths.
- Treat long-audio network multipart chunks and Gladia duration chunks as separate concepts.
- Mark research proposals as unimplemented until code, tests, and deployment all exist.

## Current Migration State

As of September 22, 2026:

- desktop launch, implementation, and build all use `apps/desktop/main.py`;
- desktop and CLI pipeline logic lives in `packages/shared_core`;
- web is a deployed Vercel product with its own cloud-safe APIs;
- old `app/` and `core/` wrappers remain for compatibility;
- old DeepL batch scripts remain for historical workflows;
- Ubuntu + Cloudflare Tunnel + R2 remains a pre-research alternative and has not been implemented.
