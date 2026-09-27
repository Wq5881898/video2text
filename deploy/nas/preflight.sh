#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

for command in docker curl findmnt openssl realpath stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
test -f .env || fail "copy .env.example to .env and configure it first"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

required=(
  VIDEO2TEXT_PUBLIC_HOST
  VIDEO2TEXT_PUBLIC_ORIGIN
  VIDEO2TEXT_STORAGE_MOUNT
  VIDEO2TEXT_DATA_DIR
  VIDEO2TEXT_CONFIG_DIR
  VIDEO2TEXT_SHARED_SECRET
  VIDEO2TEXT_PROXY_TOKEN
)
for name in "${required[@]}"; do
  test -n "${!name:-}" || fail "$name is empty"
done

[[ "$VIDEO2TEXT_PUBLIC_ORIGIN" == https://* ]] || fail "VIDEO2TEXT_PUBLIC_ORIGIN must use HTTPS"
[[ "$VIDEO2TEXT_SHARED_SECRET" != replace-* ]] || fail "replace VIDEO2TEXT_SHARED_SECRET"
[[ "$VIDEO2TEXT_PROXY_TOKEN" != replace-* ]] || fail "replace VIDEO2TEXT_PROXY_TOKEN"
((${#VIDEO2TEXT_SHARED_SECRET} >= 32)) || fail "VIDEO2TEXT_SHARED_SECRET must be at least 32 characters"
((${#VIDEO2TEXT_PROXY_TOKEN} >= 32)) || fail "VIDEO2TEXT_PROXY_TOKEN must be at least 32 characters"

storage_mount=$(realpath -m "$VIDEO2TEXT_STORAGE_MOUNT")
data_dir=$(realpath -m "$VIDEO2TEXT_DATA_DIR")
findmnt --mountpoint "$storage_mount" >/dev/null 2>&1 \
  || fail "$storage_mount is not a mounted filesystem"
[[ "$data_dir" == "$storage_mount"/* ]] \
  || fail "VIDEO2TEXT_DATA_DIR must be a child of VIDEO2TEXT_STORAGE_MOUNT"

for directory in uploads media work results state; do
  test -d "$VIDEO2TEXT_DATA_DIR/$directory" || fail "missing directory: $VIDEO2TEXT_DATA_DIR/$directory"
  [[ "$(stat -c '%u' "$VIDEO2TEXT_DATA_DIR/$directory")" == "1000" ]] \
    || fail "$VIDEO2TEXT_DATA_DIR/$directory must be owned by UID 1000"
done
test -d "$VIDEO2TEXT_CONFIG_DIR" || fail "missing directory: $VIDEO2TEXT_CONFIG_DIR"
[[ "$(stat -c '%u' "$VIDEO2TEXT_CONFIG_DIR")" == "1000" ]] \
  || fail "$VIDEO2TEXT_CONFIG_DIR must be owned by UID 1000 so the Worker can read it"
test -w "$VIDEO2TEXT_DATA_DIR/uploads" || fail "uploads directory is not writable by the current user"

source_device=$(stat -c '%d' "$VIDEO2TEXT_DATA_DIR/uploads")
target_device=$(stat -c '%d' "$VIDEO2TEXT_DATA_DIR/media")
[[ "$source_device" == "$target_device" ]] || fail "uploads and media must be on the same filesystem"

probe="$VIDEO2TEXT_DATA_DIR/uploads/.video2text-preflight-$$"
target="$VIDEO2TEXT_DATA_DIR/media/.video2text-preflight-$$"
trap 'rm -f "$probe" "$target"' EXIT
printf test >"$probe"
mv "$probe" "$target"
rm -f "$target"

docker compose config --quiet

printf 'Preflight passed. Next commands:\n'
printf '  docker compose build worker\n'
printf '  docker compose up -d\n'
printf '  docker compose ps\n'
printf '  curl --fail %s/health\n' "$VIDEO2TEXT_PUBLIC_ORIGIN"
