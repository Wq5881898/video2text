# Ubuntu/NAS deployment

This stack is the independent Docker V3 product. It serves its own web/control plane at `stt.151077.xyz` and the resumable upload/data plane at `upload.151077.xyz`. The existing Vercel product remains unchanged and available as a separate rollback path.

## Services

- Caddy terminates public HTTPS for the DNS-only `stt` and `upload` hostnames, serves the static web app, and exposes the existing Sub2API allowlist on host loopback port 8081.
- tusd receives resumable browser uploads and disables its public download endpoint.
- The single-worker Flask/Gunicorn service validates upload tickets, queues SQLite jobs, provides signed media reads to Gladia, runs the shared pipeline, and exposes protected status/result APIs.
- Successful media is removed immediately after the result and SQLite completion state are durable. The maintenance profile removes failed media after seven days and abandoned partial uploads after 24 hours. TXT/SRT results are retained.

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
cp .env.example .env
chmod 600 .env
./preflight.sh
docker compose config
docker compose build worker
docker compose up -d
docker compose ps
curl https://upload.151077.xyz/health
```

Opening `https://stt.151077.xyz/` redirects to the NAS-only UI. Caddy Basic Auth protects the web and control API. The upload host exposes only tusd, signed media reads, and a non-secret health response.

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
