# Add the Cantonese demo to Docker V3

Fetch the delivery branch `codex/cantones-demo-20261022` from the existing
`Wq5881898/video2text` GitHub repository. Use the exact delivery commit recorded
in the handoff. Its parent is `f4abb7e9f12459ff84c6b6d79606c57a55aa5cfb`, which
already includes the Qwen User-Agent fix and the deliberate removal of whole-site
Basic Auth. Do not reset to the older `9ccf2e3` deployment taskbook. No ZIP is
required and no business code needs to be recreated on the NAS.

Delivery validation on Windows: all 103 Node tests passed; the original Python
3.11 suite ran 71 tests successfully with one Caddy runtime test skipped because
the Caddy binary is unavailable. No real provider requests were made by these
tests. Docker image building and Linux/Caddy runtime acceptance remain NAS work.

## Prepare the existing host

Work in the existing repository checkout on `docker-v3`. Check worktree status, the current SHA,
active jobs, and local/remote divergence first. Back up `.env` and the running
Compose/Caddy configuration privately, with mode 600. Do not log their content.
Fetch the delivery ref and verify its commit and tree before changing files.
Fast-forward only when the current branch is an ancestor of the delivery commit.
If the host/remote has independent changes, report and reconcile those changes;
do not force-push, hard-reset, or overwrite them. After integrating, normally push
`docker-v3` and compare the local SHA against the remote SHA. Record the actual
final SHA rather than reusing the historical baseline.

The checked-in Compose file already defines `cantones` and Caddy's `/cantones`
handler. The original Worker/tusd and Sub2API routes are retained. Add only:

```dotenv
VIDEO2TEXT_CANTONES_USER=video2text
VIDEO2TEXT_CANTONES_PASSWORD_HASH='REPLACE_PRIVATELY_WITH_CADDY_BCRYPT_HASH'
```

Use a privately retained existing demo credential if available, or generate and
store a new one in a root-only credentials file. Do not put passwords, hashes or
API keys in Git, logs, chat or the acceptance report. Single-quote the bcrypt hash
in `.env` to preserve its dollar signs. Keep `.env` mode 600. This authentication
covers only the new `/cantones` prefix. Existing `/`, `/nas` and `/api` remain
public as in the newer Docker V3 commits; the old blanket-401 acceptance criteria
do not describe the current deployment.

Preserve the existing enabled translation providers (the latest deployment notes
record `minimax,qwen`). The demo uses its own MiniMax configuration; do not switch
the original site's providers to accommodate it. Reuse the private config mount
or current MiniMax environment variables. No real credentials are in this branch.

Using the actual configured `VIDEO2TEXT_DATA_DIR`, create **only** its `cantones`
child with UID/GID 1000, mode 750. Verify the resolved target is inside the
existing application data directory before changing ownership. Do not recursively
change other application data. The node image runs as UID 1000; its `/config`
mount is read-only. The new service exposes no host port.

## Validate and start

From the checkout's `deploy/nas` directory, run without printing expanded configuration:

```sh
sudo ./preflight.sh
sudo docker compose config --quiet
sudo ./verify.sh
sudo docker compose build cantones
sudo docker compose up -d --no-deps cantones
sudo docker compose up -d --no-deps caddy
sudo docker compose ps
```

`verify.sh` runs `docker compose run --rm --no-deps caddy caddy validate --config
/etc/caddy/Caddyfile --adapter caddyfile` and non-billable assertions. Recreating
Caddy applies its newly added environment variables; reloading only the file
does not update the running container environment. Do not rebuild/restart a busy
original Worker. Run the Node test suite and NAS configuration/Worker regression
tests using the available host runtime or a disposable matching container.

## Acceptance without paid jobs

- `caddy`, `cantones`, `worker`, `tusd` run without repeated restarts. FFmpeg,
  FFprobe, read-only configuration access and the persistent demo directory work
  as UID 1000. The Docker build and Caddy runtime checks must actually be run on
  the NAS; Windows-only unit tests cannot establish these results.
- Unauthenticated `/cantones`, `/cantones/`, `/cantones/api/config` and
  `/cantones/api/jobs` return 401; correct credentials give 200 for the page and
  configuration endpoint. This GET only inspects local settings/cooldown records;
  it does not call the provider. The whole prefix must be protected, not just the HTML page.
  Credentials should use a root-only temporary curl config, not command-line
  arguments or shell tracing.
- The original `/` still returns 302 to `/nas`; `/nas` is public. Existing
  `/api/health` and `/api/capabilities` behaviour/providers remain unchanged.
  `upload` health stays minimal and returns 200, its `/` and `/api/nas-ticket`
  stay 404, and tus CORS still works.
- The English/繁體中文 toggle works, assets load under `/cantones`, and the old
  desktop/mobile page links open the new entry. There are no public direct
  4178/Worker/tusd ports. Unprefixed demo endpoints are not exposed by the Node
  container. Verify forbidden cross-origin writes are rejected using an empty
  fake request only, not a real video upload.
- Sub2API on loopback 8081 and the existing public API domain retain the same
  401/404 behaviour. No Tunnel, DNS, router, main or Vercel change is required.
- With unique fake `X-Upload-Token` and `signature` values, verify the complete
  values appear zero times in **new Caddy logs**, while path/status remain logged.
  Do not print real log credentials. `log_credentials` remains disabled.

Do not submit real audio, run the paid connection check, or create paid ASR/LLM
tasks during this deployment. A full new-video quality test and YouTube upload
acceptance are separate from infrastructure acceptance. Model output is a draft,
not a guarantee of matching the English baseline. Demo media retention and
non-resumable uploads remain explicit demo limitations.

Write the deployment evidence and actual remaining issues to the private report
location specified in the handoff, without secrets. If rollback is
needed, retain the new data directory and revert only this integration's files
or use the backed-up deployment configuration; do not run `compose down -v`,
delete application data, or force a Git reset. Restoring Caddy's environment may
require recreating Caddy with its original configuration.
