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

Delegated source confirmation can explicitly send `reviewActor: "assistant"`.
Every pending item still requires a nonempty evidence note and resolved words;
it records `assistantReviewedIds`, leaves `humanReviewedIds` empty and never
claims whole-film human review. The normal UI continues to record human review.

English correction proposals receive the same treatment: an unverifiable quote,
replacement span or overlapping patch is withheld, the independent draft is
retained, and `english-evidence-*.json` records the proposal. Ordered target-ID
coverage remains mandatory and the corrected text still receives its separate
semantic audit. Withheld proposals remain visible as draft review questions.

## NAS deployment

Use the existing `deploy/nas/compose.yaml`; it includes the `cantones` service and
`Dockerfile.cantones`. No ZIP or extra Compose overlay is required. See
[`deploy/nas/CANTONES_DEPLOYMENT.md`](../../deploy/nas/CANTONES_DEPLOYMENT.md).

The service publishes no host port. The official Caddy gateway on **218** routes
the entire `/cantones` prefix, including API/media/download routes. Access is
public without Basic Auth, as requested by the user; the original Docker V3
routes retain their policy. This is a single shared demo workspace, not an
account system with per-user isolation. **148** is a different Docker host and
is not part of a Cantonese-service update.

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

## Assisted-production learning workflow (2026-10-27)

This is an assisted production workflow, not a trained ASR model or a claim of
unattended reference-level translation. The production route remains
`https://stt.151077.xyz/cantones` on **218**.

1. Upload the original video. Keep the lossless audio master and source identity;
   submit the bounded MP3 chunks through the existing MiniMax ASR adapter.
2. `financial-error-lexicon.json` **2026-10-27.1** supplies 43 source rules plus
   five reusable review instructions. Confirmed, context-matched spelling errors
   such as NYSE `bread` → `breadth` and `我的睇翻` → `我哋睇翻` can be corrected.
   Sector `呢緊` → possible `lead 緊` and quantity-scale conflicts require review;
   they are not automatic substitutions. Existing S&P/Nas100/bar and visual or
   audio evidence requirements remain in force.
3. Compare terms and quantities with the same-time, same-object frames. Check
   chart-axis units and scale, not just whether OCR or a reference agrees.
   Never automatically divide an index range by ten or replace the speaker's
   claim with an unrelated plotted value. Keep conflicting original text,
   images and a review note. Short ASR re-recognition is fallible evidence,
   not human listening or an independent engine.
4. Resolve source questions before freezing the Cantonese for translation.
   When Codex assists the review, record `reviewActor: "assistant"` and the
   supporting notes; do not mark it as whole-film human approval.
5. `translation-context-rules.json` **2026-10-27.general.3** supplies 30 general
   rules to English drafting, local correction **and final model audit**. New
   checks cover the Bollinger middle/lower band, retest conditionality,
   unsupported direct-path wording, quantities across cue boundaries and
   joined-sentence cleanup. Deterministic warnings still flag these risks when
   a model returns an empty audit; they do not silently rewrite the English.
6. Inspect number/name/unit boundaries, more-than-two-line captions and short
   or fast cues. These remain assisted layout checks; source timing is never
   invented to hide warnings. Save English revisions, recheck affected meaning,
   reload the page and download/read back the SRT. YouTube playback must be
   verified separately before claiming that acceptance.

New jobs snapshot the source lexicon in `lexicon-snapshot.json` and English rules
in `cantones-rules-snapshot.json`; resumes retain those snapshots. Updating the
deployment does not rewrite existing jobs, reprocess paid requests or upgrade
their dictionaries implicitly. Use a new job for a new-version quality test.
The original ASR and previous revisions remain available for audit.

For the next held-out video, generate and freeze the candidate from video plus
general rules first; only then read the matching reference subtitles. Compare
Cantonese and English separately. Check missing/duplicate information, names,
quantities, negation, conditions and chart positions. Reference agreement,
substring distance, subtitle counts and a clean same-model audit are not accuracy
scores; the reference can itself be wrong. Record the actual assistance used.

Deploy by pushing the tested Git delivery commit, then updating only the
`cantones` service in `/opt/video2text/deploy/nas` on **218**. Do not use the
historical first-install/Caddy migration commands for a dictionary update.
Verify the running container's rule versions and normalized runtime fingerprint
against the delivery commit; preserve all task data. No **148**, shared Caddy,
worker, tusd, Sub2API, audit proxy, DNS or Tunnel change is required.
