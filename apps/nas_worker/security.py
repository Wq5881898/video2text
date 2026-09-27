from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote


class TokenError(ValueError):
    """Raised when an upload or media token cannot be trusted."""


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise TokenError("invalid base64 token") from exc


def _signature(value: str, secret: str) -> str:
    return _b64url_encode(hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest())


def encode_upload_token(payload: dict[str, Any], secret: str) -> str:
    if not secret:
        raise TokenError("upload signing secret is not configured")
    encoded = _b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    return f"{encoded}.{_signature(encoded, secret)}"


def decode_upload_token(
    token: str,
    secret: str,
    *,
    now: int | None = None,
    require_not_expired: bool = True,
) -> dict[str, Any]:
    try:
        encoded, supplied_signature = token.split(".", 1)
    except ValueError as exc:
        raise TokenError("malformed upload token") from exc
    expected_signature = _signature(encoded, secret)
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise TokenError("invalid upload token signature")
    try:
        payload = json.loads(_b64url_decode(encoded))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TokenError("invalid upload token payload") from exc
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise TokenError("unsupported upload token")
    expires_at = int(payload.get("expires_at") or 0)
    if require_not_expired and expires_at < (now if now is not None else int(time.time())):
        raise TokenError("upload token expired")
    return payload


def sign_media_path(relative_path: str, expires_at: int, secret: str) -> str:
    if not secret:
        raise TokenError("media signing secret is not configured")
    return _signature(f"{relative_path}\n{expires_at}", secret)


def verify_media_signature(
    relative_path: str,
    expires_at: int,
    supplied_signature: str,
    secret: str,
    *,
    now: int | None = None,
) -> bool:
    current = now if now is not None else int(time.time())
    if expires_at < current:
        return False
    return hmac.compare_digest(
        supplied_signature,
        sign_media_path(relative_path, expires_at, secret),
    )


def build_signed_media_url(
    path: Path,
    *,
    data_root: Path,
    public_origin: str,
    secret: str,
    ttl_seconds: int,
    now: int | None = None,
) -> str:
    resolved_root = data_root.resolve()
    resolved_path = path.resolve()
    try:
        relative_path = resolved_path.relative_to(resolved_root).as_posix()
    except ValueError as exc:
        raise TokenError("media path is outside the data root") from exc
    expires_at = (now if now is not None else int(time.time())) + ttl_seconds
    signature = sign_media_path(relative_path, expires_at, secret)
    return (
        f"{public_origin.rstrip('/')}/media/{quote(relative_path, safe='/')}"
        f"?expires={expires_at}&signature={signature}"
    )
