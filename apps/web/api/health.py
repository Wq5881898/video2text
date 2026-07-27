from __future__ import annotations

import importlib.util
from pathlib import Path
from flask import Flask, jsonify


_SHARED_PATH = Path(__file__).resolve().parent / "_shared.py"
_SHARED_SPEC = importlib.util.spec_from_file_location("_web_shared", _SHARED_PATH)
_SHARED = importlib.util.module_from_spec(_SHARED_SPEC)
assert _SHARED_SPEC is not None and _SHARED_SPEC.loader is not None
_SHARED_SPEC.loader.exec_module(_SHARED)
REPO_ROOT = _SHARED.REPO_ROOT


def handler(_request=None):
    return {
        "ok": True,
        "app": "video2text-web",
        "status": "ready",
        "repo_root": str(REPO_ROOT),
        "surface": "web",
    }


app = Flask(__name__)


@app.route("/api/health", methods=["GET"])
@app.route("/", methods=["GET"])
def health_route():
    return jsonify(handler(None))
