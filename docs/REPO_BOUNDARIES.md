# Repository Boundaries

## Purpose

This repository contains two product surfaces in one codebase:

- desktop application
- web application

They must not share deployment scripts, runtime folders, or release artifacts directly.

## Surface Ownership

### Desktop

- source entry: `apps/desktop/main.py`
- release build script: `scripts/desktop/build_release.ps1`
- compatibility wrapper: `scripts/build_release.ps1`
- packaged output: `release/video2text/`
- desktop-only runtime files:
  - `assets/`
  - `outputs/work/`
  - PyInstaller output under `build/` and `release/`

### Web

- source root: `apps/web/`
- deploy config: `apps/web/vercel.json`
- package manifest: `apps/web/package.json`
- web-only concerns:
  - upload API
  - queue/status API
  - cloud storage
  - Vercel deployment

### Shared Core

- shared source root: `packages/shared_core/`
- compatibility wrappers currently still exist in:
  - `core/`
- speech pipeline helper scripts still live in:
  - `outputs/work/`

## Rules

- Desktop packaging must only use `apps/desktop` as its app entry.
- Web deployment must only use `apps/web` as its deployment root.
- Shared business logic should be imported through `packages/shared_core` whenever practical.
- Do not point Vercel deployment at the repository root once the real web app is scaffolded.
- Do not point PyInstaller at `apps/web` or any web build output.

## Current Migration State

As of July 27, 2026:

- desktop launch, desktop build, and desktop main implementation already use `apps/desktop`
- shared pipeline main implementation now lives in `packages/shared_core`
- old `app/` and `core/` remain temporary compatibility layers
