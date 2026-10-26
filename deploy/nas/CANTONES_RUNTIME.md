# Cantonese runtime parity

Keep the existing Python worker and the Cantonese Node service separate. This change only makes Cantonese runtime verification reproducible and reports media-tool failures accurately. It does not change ASR/translation models, prompts, dictionaries, timing or existing job formats.

## What is checked

- The image installs FFmpeg and FFprobe and runs a synthetic media smoke check as the final `node` runtime user during the build.
- Compose pins their **container** paths to `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`, overriding host-specific values in `.env`.
- `server.mjs` and `check-runtime.mjs` use the same media-tool probe.
- `/cantones/api/config` keeps its `configured` gate and adds sanitized `mediaStatus` reason codes. It does not expose executable paths, raw stderr or keys.
- The Traditional Chinese / English page distinguishes media-tool failures from missing configuration.

The build-time check uses `--media-only`: no real configuration, uploaded video or model request is needed. A successful check does **not** verify provider permissions or translation quality.

## Local and container verification

From `apps/cantonese-demo`:

```sh
node --test tests/*.test.mjs
node check-runtime.mjs --smoke
```

The smoke check generates a two-second video in a temporary directory, extracts 16 kHz mono FLAC, checks duration drift, extracts a frame and removes its temporary files. It never contacts a provider. `--media-only --smoke` can be used before configuration is mounted.

Compare `sourceFingerprint` with the approved local report. It covers root application modules, the three rule dictionaries and public page assets, normalizing Windows line endings and final blank lines. It excludes credentials, job data, tests and npm research scripts. A matching fingerprint proves these runtime sources agree even if an image tag or checkout has become stale.

The HTTP integration test uses a loopback mock provider with fake credentials and real media tools. It tests upload, source processing, English generation, SRT download, recovery from a persisted interrupted status without repeated model requests, and a missing-FFprobe failure. It does not use the user's model quota.

## Deployment on 218

First record the running image, container identity, relevant tool errors and existing readiness response. Preserve `.env`, mounts, existing jobs and any local source modifications. Do not call a failed check proof of a missing installation: wrong paths, permissions, a stale image or loader errors need distinct diagnosis.

After integrating the reviewed source into the actual `docker-v3` branch, from `/opt/video2text/deploy/nas`:

```sh
sudo docker compose config --quiet
sudo docker compose build cantones
sudo docker compose run --rm --no-deps cantones node check-runtime.mjs --smoke
```

Require `ok=true`, media tool checks passing, and both configured flags present before proceeding. Model permissions remain unverified by these commands. Wait for any active Cantonese job before replacing its service.

```sh
sudo docker compose up -d --no-deps --force-recreate cantones
sudo docker compose exec -T cantones node check-runtime.mjs --smoke
```

Verify unauthenticated `/cantones` returns 200 and `/cantones/api/config` reports `configured=true`, `mediaTools=true` and both `mediaStatus` tools ready. Reload the browser page after the service restarts. Compare the non-target services' container IDs and start times with the recorded baseline.

There is no routing change: do not recreate Caddy, worker, tusd, Sub2API or audit services. Do not change 148, DNS, Tunnel or the router. Do not rerun historical migration scripts, add login, delete volumes or replay media/model requests. Roll back only Cantonese source/image/environment changes to the recorded baseline if acceptance fails.

This repository does not bundle Windows media binaries. Local Windows and remote Linux use their native tool paths. Parity means the same reviewed application version and processing contract, with actual media checks in both environments; the binaries need not be byte-identical across operating systems.
