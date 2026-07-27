from __future__ import annotations

import sys
import uuid
from pathlib import Path


WEB_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = WEB_ROOT.parent.parent
WEB_RUNTIME_ROOT = WEB_ROOT / ".runtime"
WEB_UPLOADS_ROOT = WEB_RUNTIME_ROOT / "uploads"
WEB_OUTPUTS_ROOT = WEB_RUNTIME_ROOT / "outputs"
WEB_JOBS_ROOT = WEB_RUNTIME_ROOT / "jobs"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def ensure_runtime_dirs() -> None:
    WEB_RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    WEB_UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)
    WEB_OUTPUTS_ROOT.mkdir(parents=True, exist_ok=True)
    WEB_JOBS_ROOT.mkdir(parents=True, exist_ok=True)


def make_job_id(prefix: str = "job") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"
