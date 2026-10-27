# Isolated ASR clip diagnostics

This tool uses the **running application's** `config.mjs`, `recordedAsrRequest`, native ASR transport, media helpers and durable request ledger. It does not resume or edit the original job, change an application image, or bypass unknown-request protection. Only the diagnostic child process instruments native HTTP lifecycle events; it does not change the HTTP request body or authorization.

Prepare a clip offline first (default 60 seconds, maximum 120):

```sh
node /tmp/asr-diagnostic.mjs --app-root=/app/apps/cantonese-demo \
  --job=JOB_UUID --run=UNIQUE_RUN_ID --seconds=60 --offset=0
```

Only after audio submission is authorized, run the **same ID and parameters** with `--send`. Default preparation sends no provider requests. A completed request is cached; an unknown request is not resent. There is no retry option. A concurrent or stale `running.lock` blocks another invocation rather than assuming a previous request was not sent.

Outputs live in `.data/asr-diagnostics/JOB_UUID/UNIQUE_RUN_ID/`, separately from the original job. They include the clip, validated manifest, status, existing-format request ledger and `transport.jsonl`. Trace events record DNS, TCP, TLS, local socket flush, HTTP response headers and completion, plus bounded socket byte/queue snapshots. They never print authorization, response text or request bytes. Raw ASR output remains in the normal response ledger.

`socket_flush_finished` and `socketBytesWritten` describe local socket writes, **not proof that the remote application accepted or processed the audio**. Use actual response headers/response JSON and, where available, read-only TCP acknowledgement statistics to narrow the cause. A timeout still leaves the provider's billing/processing outcome unknown.

On 218, copy only these diagnostic files to `/tmp` in the existing `cantones` container; use its default `node` user, current environment and mounted configuration. No image build, container restart, or production source edit is required. A detached diagnostic process can be monitored through its status and trace files with bounded reads. Do not send again after an unknown outcome without fresh authorization.

Offline tests use synthetic media and loopback HTTP only:

```sh
ASR_DIAGNOSTIC_APP_ROOT=/app/apps/cantonese-demo node --test /tmp/asr-diagnostic.test.mjs
```
