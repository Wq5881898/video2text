from __future__ import annotations

import json
import os
import tempfile
import urllib.error
import urllib.request
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode


GLADIA_LIST_URL = "https://api.gladia.io/v2/pre-recorded"
GLADIA_FREE_MONTHLY_SECONDS = 10 * 60 * 60
DEEPL_FREE_USAGE_URL = "https://api-free.deepl.com/v2/usage"
DEEPL_PRO_USAGE_URL = "https://api.deepl.com/v2/usage"


def application_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


CONFIG_ROOT = Path(os.environ.get("VIDEO2TEXT_CONFIG_DIR", application_root() / "config")).resolve()
GLADIA_KEYS_PATH = CONFIG_ROOT / "gladia_keys.txt"
DEEPL_KEY_PATH = CONFIG_ROOT / "deepl_key.txt"
os.environ.setdefault("VIDEO2TEXT_CONFIG_DIR", str(CONFIG_ROOT))


@dataclass(slots=True)
class KeyCheckResult:
    valid: bool
    status: str
    detail: str = ""
    used: int | None = None
    limit: int | None = None

    @property
    def remaining(self) -> int | None:
        if self.used is None or self.limit is None:
            return None
        return max(0, self.limit - self.used)


def mask_key(key: str) -> str:
    key = key.strip()
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}...{key[-4:]}"


def read_gladia_keys(path: Path) -> list[str]:
    if not path.exists():
        return []
    keys: list[str] = []
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        key = raw.strip()
        if key and not key.startswith("#") and key not in keys:
            keys.append(key)
    return keys


def read_deepl_key(path: Path) -> str:
    if not path.exists():
        return ""
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        key = raw.strip()
        if key and not key.startswith("#"):
            return key
    return ""


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def write_gladia_keys(path: Path, keys: list[str]) -> None:
    clean = list(dict.fromkeys(key.strip() for key in keys if key.strip()))
    _atomic_write(path, "".join(f"{key}\n" for key in clean))


def write_deepl_key(path: Path, key: str) -> None:
    clean = key.strip()
    _atomic_write(path, f"{clean}\n" if clean else "")


def _request_json(request: urllib.request.Request, timeout: int) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            body = {}
        return exc.code, body


def check_gladia_key(key: str, timeout: int = 15) -> KeyCheckResult:
    month_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    offset = 0
    limit = 100
    used_seconds = 0.0
    try:
        while True:
            query = urlencode(
                {
                    "offset": offset,
                    "limit": limit,
                    "after_date": month_start.isoformat().replace("+00:00", "Z"),
                }
            )
            request = urllib.request.Request(
                f"{GLADIA_LIST_URL}?{query}",
                headers={"x-gladia-key": key.strip(), "Accept": "application/json"},
            )
            status, payload = _request_json(request, timeout)
            if status != 200:
                break
            items = payload.get("items", [])
            used_seconds += sum(
                float((item.get("file") or {}).get("audio_duration") or 0) for item in items
            )
            if len(items) < limit or not payload.get("next"):
                break
            offset += limit
    except (OSError, urllib.error.URLError) as exc:
        return KeyCheckResult(False, "Network error", str(exc))
    if status == 200:
        used = round(used_seconds)
        within_free_limit = used < GLADIA_FREE_MONTHLY_SECONDS
        return KeyCheckResult(
            within_free_limit,
            "Available (estimated)" if within_free_limit else "Free limit reached (estimated)",
            "Calculated from this month's visible jobs against Gladia's published 10-hour Free limit. "
            "Paid-plan limits are not exposed by the API.",
            used=used,
            limit=GLADIA_FREE_MONTHLY_SECONDS,
        )
    if status in {401, 403}:
        return KeyCheckResult(False, "Invalid", "Authentication rejected.")
    if status in {402, 429}:
        return KeyCheckResult(True, "Limited", f"Gladia returned HTTP {status}; check the provider dashboard.")
    return KeyCheckResult(False, "Unknown", f"Gladia returned HTTP {status}.")


def check_deepl_key(key: str, timeout: int = 15) -> KeyCheckResult:
    clean = key.strip()
    endpoint = DEEPL_FREE_USAGE_URL if clean.endswith(":fx") else DEEPL_PRO_USAGE_URL
    request = urllib.request.Request(
        endpoint,
        headers={"Authorization": f"DeepL-Auth-Key {clean}", "Accept": "application/json"},
    )
    try:
        status, payload = _request_json(request, timeout)
    except (OSError, urllib.error.URLError) as exc:
        return KeyCheckResult(False, "Network error", str(exc))
    if status == 200:
        used = payload.get("character_count")
        limit = payload.get("character_limit")
        return KeyCheckResult(True, "Valid", used=used, limit=limit)
    if status in {401, 403}:
        return KeyCheckResult(False, "Invalid", "Authentication rejected.")
    if status == 456:
        return KeyCheckResult(True, "Quota exhausted", "Monthly character quota is exhausted.")
    return KeyCheckResult(False, "Unknown", f"DeepL returned HTTP {status}.")
