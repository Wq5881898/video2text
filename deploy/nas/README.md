# Ubuntu/NAS deployment

This stack is the independent Docker V3 product. It serves its own web/control plane at `stt.151077.xyz` and the resumable upload/data plane at `upload.151077.xyz`. The existing Vercel product remains unchanged and available as a separate rollback path.

> Baseline: 2026-09-27. Already deployed; setup commands below are for a separately authorized installation, not instructions to recreate this host, disk, Vercel deployment, or Tunnel. Session authentication is design-only: see [the plan](../../docs/DOCKER_SESSION_AUTH_PLAN_ZH.md).

Docker accepts local uploads only, not media URL input. Standalone does not require `NAS_PREVIEW_*` variables. MiniMax passed the complete short-audio path; the production provider setting is `minimax,qwen`. Qwen passed one minimal real translation after a provider-specific client User-Agent fix; the full audio path was not rerun. GLM is unconfigured.

## Services

- The Cantonese video-to-English demo is a separate Node/FFmpeg service under `/cantones`, with its own prefix-wide Basic Auth. Existing Docker V3 pages and APIs keep their current public-access policy. Fetch the GitHub delivery branch and follow [the incremental deployment instructions](CANTONES_DEPLOYMENT.md); no ZIP transfer is required.
- Caddy publishes 80/443 for the DNS-only `stt` and `upload` hostnames, serves the static web app, and exposes the existing Sub2API allowlist only on `127.0.0.1:8081`. Existing Cloudflare Tunnel routing remains unchanged. Worker and tusd publish no host ports.
- The Caddy service runs the locally built `sub2api-audit-caddy:2.11.4-response-v1` image (official Caddy `2.11.4` plus the local `response_audit` module, source kept in `/opt/sub2api-input-audit/caddy-response-source`). On the loopback `8081` listener it spools whitelisted Sub2API responses to `/config/sub2api-input-audit/responses` and writes filtered request metadata to `/config/sub2api-input-audit/input.log` (rotating). Request metadata kept: path, method, status, duration, `audit_id`, `source_ip`. **Full request-body logging is temporarily disabled** — `{http.request.body}` buffers whole LLM payloads in RAM and OOM-killed this container on 2026-10-22; it must never be re-enabled on upload, media or tus paths. The service keeps a 1 GiB memory cap and 10 MiB × 3 container log rotation. Sub2API streaming is unaffected (`flush_interval -1`).
- tusd receives resumable browser uploads and disables its public download endpoint.
- The single-worker Flask/Gunicorn service validates upload tickets, queues SQLite jobs, provides signed media reads to Gladia, runs the shared pipeline, and exposes protected status/result APIs.
- Successful media and work files are removed immediately after the result and SQLite completion state are durable. Failed/partially completed media has seven-day fallback retention; incomplete uploads expire after 24 hours. The capacity high-water threshold is 80%. TXT/SRT results and task records are retained long-term; cleanup must not delete active jobs or durable results.

The Compose file pins tusd `v2.9.2` instead of using floating `latest` tags. Caddy uses the local audit image above rather than the plain `caddy:2.11.4-alpine` upstream tag. Review upstream releases and update these pins deliberately after a staging smoke test.

## Host preparation

Use a dedicated virtual disk formatted as ext4 or XFS and mount the whole disk at the generic `/srv/app-data` root. The virtual disk can live on the NAS storage pool, but the Ubuntu VM should see it as a block device rather than SMB/CIFS. Each application owns only its own child directory, so future attachment services can share the disk without sharing lifecycle rules or permissions.

```bash
sudo mkdir -p /srv/app-data
sudo chown root:root /srv/app-data
sudo chmod 755 /srv/app-data
sudo mkdir -p /srv/app-data/video2text/{uploads,media,work,results,state,cantones}
sudo mkdir -p /srv/video2text-config
sudo chown -R 1000:1000 /srv/app-data/video2text /srv/video2text-config
sudo chmod 750 /srv/app-data/video2text /srv/video2text-config
```

Both tusd and the Worker are pinned to UID 1000 so the hook can move completed uploads without copying them. Public tusd download, termination, and concatenation endpoints are disabled. Verify same-filesystem rename support before deployment:

```bash
touch /srv/app-data/video2text/uploads/.link-test
ln /srv/app-data/video2text/uploads/.link-test /srv/app-data/video2text/uploads/.link-test-2
rm /srv/app-data/video2text/uploads/.link-test /srv/app-data/video2text/uploads/.link-test-2
```

## Configuration

1. Create Cloudflare `A` records for `stt.151077.xyz` and `upload.151077.xyz`, point both to the public IPv4 address, and set both to **DNS only**. Do not add AAAA until IPv6 routing and firewalling are intentionally configured.
2. Forward public TCP ports 80 and 443, and optionally UDP 443, to this Ubuntu VM. Do not expose NAS administration ports.
3. Copy `.env.example` to `.env`, generate separate secrets with `openssl rand -hex 32`, generate a Caddy password hash, and restrict `.env` to mode `0600`.
4. Put Gladia and translation credentials in `.env` or mount compatible JSON files under `/srv/video2text-config`.
5. Keep the Vercel environment unchanged. Docker V3 issues upload tickets and serves job status/results locally.

Do not commit `.env` or the configuration directory.

Before choosing `VIDEO2TEXT_MAX_UPLOAD_BYTES` and `VIDEO2TEXT_MAX_ACTIVE_JOBS`, check the data disk capacity. Peak space can exceed the original upload size because long media may temporarily coexist with extracted audio, split parts, work files, and results.

## Start and verify

```bash
cd /opt/video2text/deploy/nas
test -e .env || cp .env.example .env
chmod 600 .env
./preflight.sh
docker compose config --quiet
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose build worker cantones
docker compose up -d
docker compose ps
curl https://upload.151077.xyz/health
```

The repeated `caddy` is intentional: Compose service name first, container executable second. For the existing image, `docker compose run ... caddy validate` without the executable is not the working command. Use the full invocation above, and do not print expanded Compose configuration or private environment values. Caddy validation does not prove public routing or authentication behavior.

Current temporary policy (user-requested): existing `stt.151077.xyz` routes have no Basic Auth; `/` redirects to `/nas` without login, and the original web/control API is publicly reachable. Only the new `/cantones` prefix uses `VIDEO2TEXT_CANTONES_USER` and `VIDEO2TEXT_CANTONES_PASSWORD_HASH`, including all demo API/media routes. The upload host still exposes only ticket-validated tusd, signed media reads, and minimal health. No user registration, ownership isolation, or cookie-session endpoints are deployed; do not mistake this demo password gate for the future auth design.

Verification should distinguish loopback 8081 allowlist behavior, local TLS with correct hostname/SNI, and public HTTPS. Check worker/tusd port isolation, tus resume, provider availability, result download, and successful media/work deletion after persistence. Record actual test output by code version rather than copying stale exact test counts. Do not submit paid E2E jobs without authorization.

## Daily fallback cleanup

Install the supplied systemd files after the repository is located at `/opt/video2text`:

```bash
sudo cp systemd/video2text-cleanup.service /etc/systemd/system/
sudo cp systemd/video2text-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now video2text-cleanup.timer
systemctl list-timers video2text-cleanup.timer
```

Run a manual lifecycle pass with:

```bash
docker compose --profile maintenance run --rm cleanup
```
