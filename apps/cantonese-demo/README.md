# Cantonese video to English subtitles

The simple entry is `/cantones`, with Traditional Chinese and English UI. It
extracts the original audio using FFmpeg, transcribes Cantonese with MiniMax ASR,
checks recurring errors and contemporaneous video frames using MiniMax-M3,
translates the approved source to English, and reviews the translation. Genuine
source questions pause processing for targeted confirmation. Missing visual
evidence alone does not prove a transcription error.

Download produces an English SRT with the original media basename. The result is
an editable automatic draft. Model review does not replace human quality review
or YouTube playback acceptance. The current MiniMax pipeline can still miss
qualifiers, negation and specialised expressions; publication is not evidence of
matching the reference subtitle quality.

## Run locally

Requires Node.js 22+, FFmpeg and FFprobe. There are no npm dependencies.

```sh
node server.mjs
# http://127.0.0.1:4178/cantones
node --test tests/*.test.mjs
```

`VIDEO2TEXT_CONFIG_DIR` selects a private configuration directory. MiniMax can
come from `providers.json` (`providers.minimax.api_key`, `base_url`, `model`),
legacy `minimax.json`, or `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`.
ASR supports the separate `MINIMAX_ASR_API_KEY`, `MINIMAX_ASR_ENDPOINT` and
`MINIMAX_ASR_MODEL` overrides. Defaults are `asr-1.0` and `MiniMax-M3`.
Image review uses the MiniMax Messages image/tool interface; an arbitrary chat
completion endpoint is not an equivalent replacement. No current chat-session
model is represented as a callable translation API.

Connection checks send a small text request and cache successful checks for five
minutes. ASR and image permissions are confirmed by their first actual requests.
The offline tests do not make paid provider requests.

New jobs retain a lossless master locally and send mono 16 kHz, 64 kbps MP3
chunks of at most 120 seconds to ASR, cutting near pauses where possible. Each
chunk is cut directly from its original source interval; MP3 padding never
advances the next chunk's timestamp. Codec, sample rate, channels and duration
are checked before submission. The eight-minute ASR budget remains configurable
through `MINIMAX_ASR_TIMEOUT_MS`.

The media checkpoint freezes the upload encoding and boundaries. Existing jobs
without that field continue using their original FLAC chunks and request cache.
To test the new upload plan for an old failed job, create a separate job from the
same source media and preserve the old job and request records; do not replace
its checkpoint or silently resend its unknown requests.

Scene detection uses low-resolution keyframes with a one-minute budget. It adds
suggested sampling times to the regular 15-second inventory. If this optional
scan fails, `inventory-sampling.json` records a periodic fallback; the regular
samples and each source cue's full-resolution review image remain available.
Resuming this stage reuses completed ASR requests.

Unattached frame references are quarantined in `review-evidence-N.json`. A
correction relying on one is withheld and becomes a source review question;
unsupported inventory claims are excluded from accepted evidence. Frame IDs are
never guessed or remapped. Valid claims still pass the strict evidence checker,
and saved model responses can be revalidated without submitting them again.

## NAS deployment

Use the existing `deploy/nas/compose.yaml`; it includes the `cantones` service and
`Dockerfile.cantones`. No ZIP or extra Compose overlay is required. See
[`deploy/nas/CANTONES_DEPLOYMENT.md`](../../deploy/nas/CANTONES_DEPLOYMENT.md).

The service publishes no host port. Caddy protects the entire `/cantones` prefix,
including API/media/download routes, using its separate Basic Auth credentials.
The existing Docker V3 routes retain their current public-access policy. This
is a single shared demo workspace, not an account system with per-user isolation.

Private API configuration is mounted read-only at `/config`. All uploads, jobs,
frames and results live under the host data directory's `cantones` child, mounted
at `/app/apps/cantonese-demo/.data`. They are excluded from Git and image builds.
Keep this directory when rebuilding/restarting. Demo retention is manual; the
old Worker cleanup service does not manage these demo files.

The simple flow accepts up to 512 MiB and 30 minutes and processes one job at a
time. Its raw upload uses the direct Caddy/Node route, not the original tus
resumable uploader. Unknown provider outcomes require explicit retry and can
have duplicate billing; successful recorded steps are reused. Source IDs,
timings, rule snapshots, image evidence, source/English revisions and model
responses are retained. Editing English marks the prior model review stale.
