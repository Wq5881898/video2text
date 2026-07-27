from __future__ import annotations

from ._shared import REPO_ROOT


def handler(_request=None):
    return {
        "ok": True,
        "app": "video2text-web",
        "status": "ready",
        "repo_root": str(REPO_ROOT),
        "surface": "web",
    }
