# Packaging And Deploy

## Desktop Packaging

Build the Windows desktop release with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop\build_release.ps1
```

Compatibility wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

Desktop release output:

```text
release/video2text/video2text/
```

Desktop release depends on:

- bundled `ffmpeg.exe`
- bundled `ffprobe.exe`
- external runtime keys under:
  - `release/video2text/video2text/config/gladia_keys.txt`
  - `release/video2text/video2text/config/deepl_key.txt`

## Web Deploy

The web app is intentionally isolated under:

```text
apps/web/
```

When the real web surface is implemented, deploy from `apps/web`, not from the repository root.

Expected future commands:

```powershell
cd apps\web
npm install
npm run build
npm run deploy
```

## Separation Checklist

- Desktop packaging uses `apps/desktop/main.py`
- Desktop packaging writes to `release/`
- Web deployment uses `apps/web/vercel.json`
- Shared business logic is consumed through `packages/shared_core`
- Desktop-only runtime files stay out of `apps/web`
- Web deployment config stays out of `release/`
