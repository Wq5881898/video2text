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
for block in caddy.split('    log {')[1:]:
    for rule in ('format filter', 'wrap json',
                 'request>headers>X-Upload-Token delete',
                 'request>headers>X-Video2text-Proxy-Token delete',
                 'request>uri query', 'delete signature'):
        assert rule in block, 'Missing log redaction rule'
route = caddy.split('    route {', 1)[1]
assert route.index('basic_auth') < route.index('redir / /nas 302')
assert '-hooks-http-backoff=2s' in compose
assert '127.0.0.1:8081:8081' in compose
assert 'env_file:' in compose
assert 'VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS=minimax' in Path('.env.example').read_text()
for name, end in [('worker', 'cleanup'), ('tusd', 'caddy')]:
    block = compose.split('  '+name+':\n', 1)[1].split('\n  '+end+':', 1)[0]
    assert '\n    ports:' not in block, name+' must not expose host ports'
print('Non-billable configuration assertions passed')
PY
