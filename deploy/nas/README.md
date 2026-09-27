# Ubuntu/NAS deployment

This stack is an opt-in data plane for the existing Vercel web interface. It does not replace the current Vercel Blob path until `/nas` has passed real-device tests.

## Services

- Caddy terminates public HTTPS on the DNS-only upload hostname.
- tusd receives resumable browser uploads and disables its public download endpoint.
- The single-worker Flask/Gunicorn service validates upload tickets, queues SQLite jobs, provides signed media reads to Gladia, runs the shared pipeline, and exposes protected status/result APIs.
- The maintenance profile removes completed or failed media after seven days and abandoned partial uploads after 24 hours. TXT/SRT results are retained.

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

1. Create a Cloudflare `A`/`AAAA` record such as `upload.151077.xyz` pointing to the public IP and set it to **DNS only**.
2. Forward public TCP ports 80 and 443, and optionally UDP 443, to this Ubuntu VM. Do not expose NAS administration ports.
3. Copy `.env.example` to `.env`, generate separate secrets with `openssl rand -hex 32`, and set the hostname and allowed Vercel origin.
4. Put Gladia and translation credentials in `.env` or mount compatible JSON files under `/srv/video2text-config`.
5. Copy the same `VIDEO2TEXT_SHARED_SECRET` and `VIDEO2TEXT_PROXY_TOKEN` into Vercel as `NAS_SHARED_SECRET` and `NAS_PROXY_TOKEN`. Set `NAS_UPLOAD_ENDPOINT=https://upload.example.com/files/` and `NAS_API_BASE=https://upload.example.com`.

Do not commit `.env` or the configuration directory.

Before choosing `VIDEO2TEXT_MAX_UPLOAD_BYTES` and `VIDEO2TEXT_MAX_ACTIVE_JOBS`, check the data disk capacity. Peak space can exceed the original upload size because long media may temporarily coexist with extracted audio, split parts, work files, and results.

## Start and verify

```bash
cd /opt/video2text/deploy/nas
cp .env.example .env
docker compose config
docker compose build worker
docker compose up -d
docker compose ps
curl https://upload.example.com/health
```

The default Vercel page continues using Vercel Blob. Open `/nas` to test the NAS path after the matching Vercel environment variables are configured.

## Daily seven-day cleanup

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
