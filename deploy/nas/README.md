# Ubuntu/NAS deployment

This stack is the independent Docker V3 product. It serves its own web/control plane at `stt.151077.xyz` and the resumable upload/data plane at `upload.151077.xyz`. The existing Vercel product remains unchanged and available as a separate rollback path.

> Baseline: 2026-09-27. Already deployed; setup commands below are for a separately authorized installation, not instructions to recreate this host, disk, Vercel deployment, or Tunnel. Session authentication is design-only: see [the plan](../../docs/DOCKER_SESSION_AUTH_PLAN_ZH.md).

Docker accepts local uploads only, not media URL input. Standalone does not require `NAS_PREVIEW_*` variables. MiniMax has been verified; set the enabled-provider environment configuration to `minimax` only. Qwen is disabled after HTTP 403; GLM is unconfigured.

## Services

- Caddy publishes 80/443 for the DNS-only `stt` and `upload` hostnames, serves the static web app, and exposes the existing Sub2API allowlist only on `127.0.0.1:8081`. Existing Cloudflare Tunnel routing remains unchanged. Worker and tusd publish no host ports.
- tusd receives resumable browser uploads and disables its public download endpoint.
- The single-worker Flask/Gunicorn service validates upload tickets, queues SQLite jobs, provides signed media reads to Gladia, runs the shared pipeline, and exposes protected status/result APIs.
- Successful media and work files are removed immediately after the result and SQLite completion state are durable. Failed/partially completed media has seven-day fallback retention; incomplete uploads expire after 24 hours. The capacity high-water threshold is 80%. TXT/SRT results and task records are retained long-term; cleanup must not delete active jobs or durable results.

The Compose file pins Caddy `2.11.4-alpine` and tusd `v2.9.2` instead of using floating `latest` tags. Review upstream releases and update these pins deliberately after a staging smoke test.

## Host preparation

Use a dedicated virtual disk formatted as ext4 or XFS and mount the whole disk at the generic `/srv/app-data` root. The virtual disk can live on the NAS storage pool, but the Ubuntu VM should see it as a block device rather than SMB/CIFS. Each application owns only its own child directory, so future attachment services can share the disk without sharing lifecycle rules or permissions.

```bash
sudo mkdir -p /srv/app-data
sudo chown root:root /srv/app-data
sudo chmod 755 /srv/app-data
sudo mkdir -p /srv/app-data/video2text/{uploads,media,work,results,state}
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
docker compose build worker
docker compose up -d
docker compose ps
curl https://upload.151077.xyz/health
```

The repeated `caddy` is intentional: Compose service name first, container executable second. For the existing image, `docker compose run ... caddy validate` without the executable is not the working command. Use the full invocation above, and do not print expanded Compose configuration or private environment values. Caddy validation does not prove public routing or authentication behavior.

Current temporary policy (user-requested): `stt.151077.xyz` has no Basic Auth; `/` redirects to `/nas` without login, and the web/control API is publicly reachable. The upload host still exposes only ticket-validated tusd, signed media reads, and minimal health. Existing Basic Auth credentials are retained privately for rollback but are no longer enforced. No user registration, ownership isolation, or cookie-session endpoints are deployed; do not mistake this temporary public-access state for the future auth design.

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
