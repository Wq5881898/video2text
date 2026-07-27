from __future__ import annotations

from ._shared import REPO_ROOT

from packages.shared_core import AUDIO_EXTS, SUPPORTED_EXTS, VIDEO_EXTS


def handler(_request=None):
    return {
        "ok": True,
        "surface": "web",
        "repo_root": str(REPO_ROOT),
        "supported_exts": sorted(SUPPORTED_EXTS),
        "audio_exts": sorted(AUDIO_EXTS),
        "video_exts": sorted(VIDEO_EXTS),
        "output_formats": ["txt", "srt"],
        "translation": {
            "enabled": True,
            "target_language": "zh",
        },
        "deployment_boundary": {
            "desktop_release_root": "release/video2text/",
            "web_root": "apps/web/",
        },
    }
