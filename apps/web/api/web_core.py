from __future__ import annotations

import hashlib
import hmac
import os
import re
from pathlib import Path
from urllib.parse import urlparse


AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v"}
SUPPORTED_EXTS = AUDIO_EXTS | VIDEO_EXTS
OUTPUT_FORMATS = {"txt", "srt"}
MEDIA_BLOB_HOST = "si4slzwkn8wdmagr.public.blob.vercel-storage.com"
MEDIA_PATH_RE = re.compile(
    r"^/(?:uploads/[^/]+|cloud-smoke/[^/]+|[^/]+)\.(?:m4a|m4b|mp3|wav|flac|aac|ogg|opus|mp4|mov|mkv|avi|wmv|webm|flv|m4v)$",
    re.IGNORECASE,
)


def source_cleanup_token(source_url: str) -> str | None:
    try:
        parsed = urlparse(source_url)
        managed = (
            parsed.scheme == "https"
            and parsed.hostname == MEDIA_BLOB_HOST
            and parsed.port is None
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and MEDIA_PATH_RE.fullmatch(parsed.path) is not None
        )
    except ValueError:
        managed = False
    secret = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
    if not managed or not secret:
        return None
    return hmac.new(
        secret.encode("utf-8"),
        f"release:{source_url}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

def classify_media(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    raise ValueError(f"unsupported media type: {path}")


def build_cloud_capabilities() -> dict[str, object]:
    has_gladia = bool(os.environ.get("GLADIA_API_KEY", "").strip())
    has_minimax = bool(os.environ.get("MINIMAX_API_KEY", "").strip())
    has_blob = bool(os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip())
    return {
        "supported_exts": sorted(SUPPORTED_EXTS),
        "audio_exts": sorted(AUDIO_EXTS),
        "video_exts": sorted(VIDEO_EXTS),
        "output_formats": sorted(OUTPUT_FORMATS),
        "translation": {
            "enabled": has_minimax,
            "target_language": "zh",
        },
        "execution": {
            "mode": "sync-direct",
            "notes": [
                "API accepts upload or URL.",
                "Cloud runtime calls Gladia directly for transcription.",
                "Results are returned inline and downloaded client-side.",
                "Large media may exceed serverless time limits.",
            ],
        },
        "environment": {
            "blob_configured": has_blob,
            "gladia_configured": has_gladia,
            "minimax_configured": has_minimax,
        },
    }
