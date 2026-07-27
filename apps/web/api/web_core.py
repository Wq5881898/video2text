from __future__ import annotations

import os
from pathlib import Path


AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v"}
SUPPORTED_EXTS = AUDIO_EXTS | VIDEO_EXTS
OUTPUT_FORMATS = {"txt", "srt"}

def classify_media(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    raise ValueError(f"unsupported media type: {path}")


def build_cloud_capabilities() -> dict[str, object]:
    has_gladia = bool(os.environ.get("GLADIA_API_KEY", "").strip())
    has_deepl = bool(os.environ.get("DEEPL_KEY", "").strip())
    has_blob = bool(os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip())
    return {
        "supported_exts": sorted(SUPPORTED_EXTS),
        "audio_exts": sorted(AUDIO_EXTS),
        "video_exts": sorted(VIDEO_EXTS),
        "output_formats": sorted(OUTPUT_FORMATS),
        "translation": {
            "enabled": has_deepl,
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
            "deepl_configured": has_deepl,
        },
    }
