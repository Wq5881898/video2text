# Packaging And Deploy

> Updated: 2026-09-22

## Desktop Packaging

Build and verify the Windows release from the repository root:

```powershell
cd D:\projectQ\video2text
powershell -ExecutionPolicy Bypass -File scripts\desktop\build_release.ps1
```

Compatibility wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

Verified output:

```text
release\video2text\video2text\video2text.exe
```

Keep the complete `release\video2text\video2text\` directory. Moving only the EXE breaks PyInstaller, Qt, ffmpeg, config, and cache paths.

### Included Runtime

- PyInstaller application and `_internal/` dependencies;
- bundled `bin/ffmpeg.exe` and `bin/ffprobe.exe`;
- Python helper modules under `outputs/work/`;
- runtime `config/` containing available local Gladia/MiniMax/GLM/Qwen configuration;
- writable `outputs/work/jobs/` created next to the executable as needed.

Runtime configuration paths:

```text
release\video2text\video2text\config\gladia_keys.txt
release\video2text\video2text\config\minimax.json
release\video2text\video2text\config\glm.json
release\video2text\video2text\config\qwen.json
```

These files can contain secrets. The release directory must be handled as a private artifact and must not be committed.

### Public GitHub Artifact

Never upload the private build directory directly. After the verified build completes, create a sanitized public ZIP:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop\package_public_release.ps1
```

Outputs:

```text
release\artifacts\video2text-windows-x64-v0.1.0.zip
release\artifacts\video2text-windows-x64-v0.1.0.zip.sha256
```

The packager copies the complete one-folder application, removes local credentials and runtime jobs/logs, writes empty provider templates, scans text files for every known local key, adds `README-FIRST.txt`, and then creates the ZIP and SHA256 file. A detected secret aborts packaging.

Published `v0.1.0` release:

```text
https://github.com/Wq5881898/video2text/releases/tag/v0.1.0
```

The published ZIP SHA256 is `1f91c8e2d863d1c071cd1bd4af1a8f5be5933e6d3c6db5d1385560f60f36169c`.

### Build Safeguards

The build script:

1. refuses a release target outside the repository `release/` directory;
2. refuses to rebuild over a running packaged client;
3. isolates `PATH` so unrelated Poppler/ICU DLLs cannot pollute PyInstaller discovery;
4. bundles the shared audio chunk and LLM translation modules;
5. normalizes VC runtime DLL priority and removes incompatible ICU DLLs;
6. runs `scripts/desktop/smoke_test_release.ps1` before reporting success.

The packaged smoke test verifies imports/DLLs, config and job paths, key readability, English deduplication, real splitting of a generated 12,309-second audio fixture, merged SRT offsets, and GUI drag/drop initialization. It does not submit paid provider jobs.

## Web Development

The web product is isolated under `apps/web/`.

Python-only local helper:

```powershell
cd D:\projectQ\video2text\apps\web
D:\projectQ\.venv\Scripts\python.exe dev_server.py
```

This helper serves the static UI and sync Python APIs, but it does not reproduce the Node background-job and native media-probing runtime. Use Vercel CLI for the complete local surface:

```powershell
cd D:\projectQ\video2text\apps\web
npm install
npm run build
vercel dev
```

## Web Production Deploy

Current production URL:

```text
https://web-iota-one-31.vercel.app
```

Deploy only from `apps/web`, never from the repository root:

```powershell
cd D:\projectQ\video2text\apps\web
npm install
npm run build
vercel --prod
```

Required production environment:

- `GLADIA_API_KEY`
- `MINIMAX_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET`
- optional `MINIMAX_BASE_URL`
- optional `MINIMAX_MODEL`

The production routes and daily `04:15 UTC` Blob cleanup schedule are defined in `apps/web/vercel.json`.

## Verification

Local unit tests:

```powershell
cd D:\projectQ\video2text
D:\projectQ\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"

cd apps\web
node --test api/*.test.js
```

Production read-only probes:

```powershell
curl.exe https://web-iota-one-31.vercel.app/api/health
curl.exe https://web-iota-one-31.vercel.app/api/capabilities
```

`/api/capabilities` currently reports basic sync/environment capability only; it is not a complete inventory of durable jobs and long-audio behavior.

Run `npm run test:cloud` only when a real deployed smoke test is intended, because it can use Blob and provider resources.

## Separation Checklist

- Desktop packaging starts from `apps/desktop/main.py` and writes only to `release/` and `build/`.
- Web deployment starts from `apps/web/` and never reads the desktop `release/` directory.
- Desktop reusable logic lives in `packages/shared_core/`; web-safe cloud logic lives in `apps/web/api/`.
- Local runtime state, secrets, `node_modules/`, build outputs, and test artifacts remain outside Git.
- R2/Ubuntu is a documented alternative only and is not part of the current deployment.
- Public GitHub assets must come from `release/artifacts/`, never directly from the private `release/video2text/` build.
