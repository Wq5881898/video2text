# Cantonese ASR request timeout

The web ASR call previously inherited the generic 180-second model timeout, while full-video evaluation explicitly allowed 480 seconds. A real 448.5-second audio chunk was interrupted after 180.395 seconds. No complete response was saved, so the request outcome remains unknown; a client timeout does not prove the provider did not process or charge the request.

The web workflow, full-video evaluation and targeted audio rechecks now share `recordedAsrRequest` with an eight-minute default. `MINIMAX_ASR_TIMEOUT_MS` may override it with an integer from 1 to 1800000. Text/vision request budgets are unchanged. ASR uses native Node HTTP with the same total abort signal so a separate fetch header/body deadline cannot silently shorten the configured budget. Multipart encoding and Content-Length are checked with a local HTTP fixture; no new runtime package is required.

Completed caches retain their original identity and remain reusable after a timeout change. Existing frozen source settings, models, glossary snapshots and chunk boundaries are not changed. Unknown requests still require explicit permission to resend. Never remove an intent or fabricate a response to bypass that gate.

Future interrupted requests record the timeout, elapsed time, phase (waiting for headers, reading the body or saving the response), HTTP status if received, and a sanitized transport error code. They do not store keys, raw network errors or audio. An explicit retry archives prior interruption metadata before continuing. Both UI languages explain a timeout rather than showing only a generic failure.

## Verify and deploy on 218

Use the same runtime-parity deployment procedure, updating only `cantones`. Do not change 148, Caddy, worker, tusd, Sub2API, auditing, DNS or Tunnel.

1. Preserve the current paused job, its uploaded media, checkpoint, intents and any responses. Record the running image and non-target container identities.
2. Integrate the reviewed GitHub version. Build `cantones`; the existing apt layer is unchanged and can be reused.
3. Run the application tests in the new isolated image without production data or provider credentials. The suite contains 114 tests: Windows runs all 114; Linux intentionally skips the single Windows-specific file-lock test.
4. Run `node check-runtime.mjs --smoke` with actual Compose configuration. Require `ok=true`, `asrTimeoutMs=480000` (unless deliberately overridden), matching approved source fingerprint and real media extraction/frame checks. This command makes no model requests.
5. With no running task, replace only `cantones`, then repeat the runtime and public readiness checks. Confirm non-target containers were not restarted.
6. Keep the existing job paused until the user has explicitly authorized a resend of its unknown first ASR request. The deployment itself must not trigger a paid retry or media reupload.

If authorized, resume only the existing job once using the normal API/UI `retryUnknown` gate. Completed steps are reused; the original unknown intent is archived. This permission covers one resend of that specific unknown block, not silent repeats after another failure. Other fresh chunks belong to the user's original video-processing request. If another request becomes unknown, stop and report rather than repeatedly resending.

Keep provider/network uncertainty distinct from the proven client-side timeout configuration bug. Increasing a deadline does not guarantee provider latency or recognition quality. No real audio is sent by the local regression tests.
