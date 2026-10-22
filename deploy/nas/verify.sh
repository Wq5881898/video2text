#!/bin/sh
# Local configuration checks only. No provider calls or writes to application data.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
docker compose config --quiet
# Official image uses CMD, not an ENTRYPOINT: service + executable are required.
docker compose run --rm --no-deps caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile
python3 -B - <<'PY'
from pathlib import Path
caddy = Path('Caddyfile').read_text()
compose = Path('compose.yaml').read_text()
assert 'log_credentials' not in caddy
blocks = caddy.split('    log {')[1:]
for block in blocks:
    for rule in ('format filter', 'wrap json',
                 'request>uri query', 'delete signature'):
        assert rule in block, 'Missing log redaction rule'
# Public hosts redact the custom upload/proxy headers individually; the Sub2API
# block drops every request header wholesale plus key/api_key/token queries.
public_blocks = [b for b in blocks if 'output stdout' in b]
for block in public_blocks:
    for rule in ('request>headers>X-Upload-Token delete',
                 'request>headers>X-Video2text-Proxy-Token delete'):
        assert rule in block, 'Missing public host log redaction rule'
for block in blocks:
    if 'output file /config/sub2api-input-audit' in block:
        assert 'request>headers delete' in block
        for field in ('key', 'api_key', 'token', 'signature'):
            assert 'delete ' + field in block
# Full request bodies must never be logged: {http.request.body} buffers whole
# payloads in RAM and OOM-killed this container on 2026-10-22.
for line in caddy.splitlines():
    if 'log_append' in line and '{' in line:
        assert '{http.request.body}' not in line, 'Full request body logging must stay off'
assert 'log_append @audit_input <audit_id {http.request.uuid}' in caddy
assert 'response_audit @audit_input' in caddy
assert 'flush_interval -1' in caddy
# The Sub2API response spool needs the locally built Caddy image and its caps.
caddy_service = compose.split('  caddy:\n', 1)[1].split('\n  tusd:', 1)[0]
assert 'image: sub2api-audit-caddy:2.11.4-response-v1' in caddy_service
assert 'mem_limit: 1g' in caddy_service
assert 'memswap_limit: 1g' in caddy_service
route = caddy.split('    route {', 1)[1]
web = caddy.split('{$VIDEO2TEXT_PUBLIC_HOST}', 1)[0]
demo, other = web.split('        handle @cantones {', 1)
protected, rest = other.split('        handle @control {', 1)
assert 'basic_auth' in protected
assert '{$VIDEO2TEXT_CANTONES_PASSWORD_HASH}' in protected
assert 'reverse_proxy cantones:4178' in protected
assert 'basic_auth' not in demo + rest, 'Existing public routes must stay public'
assert route.index('redir / /nas 302') < route.index('handle @control')
assert '-hooks-http-backoff=2s' in compose
assert '127.0.0.1:8081:8081' in compose
assert 'env_file:' in compose
assert 'VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS=minimax' in Path('.env.example').read_text()
for name, end in [('worker', 'cleanup'), ('tusd', 'caddy')]:
    block = compose.split('  '+name+':\n', 1)[1].split('\n  '+end+':', 1)[0]
    assert '\n    ports:' not in block, name+' must not expose host ports'
cantones = compose.split('  cantones:\n', 1)[1].split('\n  cleanup:', 1)[0]
assert '\n    ports:' not in cantones
assert 'CANTONES_ONLY: 1' in cantones
assert 'CANTONES_PUBLIC_ORIGIN: https://${VIDEO2TEXT_WEB_HOST}' in cantones
assert '${VIDEO2TEXT_DATA_DIR:?Set VIDEO2TEXT_DATA_DIR in .env}/cantones' in cantones
print('Non-billable configuration assertions passed')
PY
