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

_CORE_PATH = Path(__file__).resolve().parent / "web_core.py"
_CORE_SPEC = importlib.util.spec_from_file_location("_web_core", _CORE_PATH)
_CORE = importlib.util.module_from_spec(_CORE_SPEC)
assert _CORE_SPEC is not None and _CORE_SPEC.loader is not None
_CORE_SPEC.loader.exec_module(_CORE)
build_cloud_capabilities = _CORE.build_cloud_capabilities


def handler(_request=None):
    capabilities = build_cloud_capabilities()
    return {
        "ok": True,
        "surface": "web",
        "repo_root": str(REPO_ROOT),
        **capabilities,
        "deployment_boundary": {
            "desktop_release_root": "release/video2text/",
            "web_root": "apps/web/",
        },
    }


app = Flask(__name__)


@app.route("/api/capabilities", methods=["GET"])
@app.route("/", methods=["GET"])
def capabilities_route():
    return jsonify(handler(None))
