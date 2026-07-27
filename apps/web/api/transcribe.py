from __future__ import annotations

import json
from urllib.parse import urlparse

from ._shared import REPO_ROOT


def _json_from_request(request) -> dict:
    if request is None:
        return {}
    body = getattr(request, "body", None)
    if body is None:
        return {}
    if isinstance(body, bytes):
        raw = body.decode("utf-8")
    else:
        raw = str(body)
    return json.loads(raw or "{}")


def _validate_source_url(value: str) -> str | None:
    if not value:
        return "source_url is required"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return "source_url must start with http:// or https://"
    if not parsed.netloc:
        return "source_url host is missing"
    return None


def handler(request=None):
    payload = _json_from_request(request)
    input_mode = str(payload.get("input_mode", "upload")).strip().lower()
    source_url = str(payload.get("source_url", "")).strip()
    file_name = str(payload.get("file_name", "")).strip()
    file_size = payload.get("file_size")
    file_type = payload.get("file_type")
    output_format = str(payload.get("output_format", "txt")).strip().lower()
    translate = bool(payload.get("translate", True))

    errors: list[str] = []
    if input_mode not in {"upload", "url"}:
        errors.append("input_mode must be one of: upload, url")
    elif input_mode == "url":
        source_error = _validate_source_url(source_url)
        if source_error:
            errors.append(source_error)
    elif input_mode == "upload":
        if not file_name:
            errors.append("file_name is required when input_mode=upload")
        if file_size in (None, ""):
            errors.append("file_size is required when input_mode=upload")
        else:
            try:
                if int(file_size) <= 0:
                    errors.append("file_size must be greater than 0")
            except (TypeError, ValueError):
                errors.append("file_size must be an integer")
    if output_format not in {"txt", "srt"}:
        errors.append("output_format must be one of: txt, srt")

    if errors:
        return {
            "ok": False,
            "surface": "web",
            "status": "invalid_request",
            "errors": errors,
        }

    return {
        "ok": True,
        "surface": "web",
        "status": "not_implemented",
        "repo_root": str(REPO_ROOT),
        "message": "Request contract accepted. Direct upload storage and cloud job execution are the next step.",
        "request": {
            "input_mode": input_mode,
            "source_url": source_url,
            "file_name": file_name or None,
            "file_size": int(file_size) if file_size not in (None, "") else None,
            "file_type": file_type or None,
            "output_format": output_format,
            "translate": translate,
        },
    }
