from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .store import JobStore


def _safe_remove_tree(path: Path, root: Path) -> bool:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as exc:
        raise RuntimeError(f"refusing to delete path outside {resolved_root}: {resolved_path}") from exc
    if resolved_path == resolved_root:
        raise RuntimeError(f"refusing to delete lifecycle root: {resolved_root}")
    if not resolved_path.exists():
        return False
    if resolved_path.is_dir():
        shutil.rmtree(resolved_path)
    else:
        resolved_path.unlink()
    return True


def _delete_job_media(job: dict, data_root: Path, store: JobStore) -> int:
    deleted = 0
    media_root = data_root / "media"
    # The job directory is deterministic, so cleanup still works if tusd moved
    # the file but the process stopped before the SQLite enqueue was committed.
    deleted += int(_safe_remove_tree(media_root / job["job_id"], media_root))
    deleted += int(_safe_remove_tree(data_root / "work" / job["job_id"], data_root / "work"))
    store.mark_media_deleted(job["job_id"])
    return deleted


def _cleanup_orphan_uploads(upload_root: Path, older_than_seconds: int, now: float) -> int:
    removed = 0
    upload_root.mkdir(parents=True, exist_ok=True)
    identifiers = {path.name.removesuffix(".info") for path in upload_root.iterdir()}
    for identifier in identifiers:
        candidates = [upload_root / identifier, upload_root / f"{identifier}.info"]
        existing = [path for path in candidates if path.exists()]
        if not existing:
            continue
        newest_mtime = max(path.stat().st_mtime for path in existing)
        if now - newest_mtime <= older_than_seconds:
            continue
        for path in existing:
            if path.is_file():
                path.unlink()
                removed += 1
    return removed


def run_cleanup(
    data_root: Path,
    *,
    retention_days: int = 7,
    incomplete_hours: int = 24,
    high_water_percent: float = 80.0,
) -> dict:
    store = JobStore(data_root / "state" / "video2text.sqlite3")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat().replace("+00:00", "Z")
    incomplete_cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=incomplete_hours)
    ).isoformat().replace("+00:00", "Z")
    expired_upload_jobs = store.expire_abandoned_uploads(incomplete_cutoff)
    removed_jobs = []
    removed_paths = 0
    for job in store.cleanup_candidates(cutoff):
        removed_paths += _delete_job_media(job, data_root, store)
        removed_jobs.append(job["job_id"])

    usage = shutil.disk_usage(data_root)
    for job in store.cleanup_candidates(cutoff, ignore_cutoff=True):
        if usage.used / usage.total * 100 < high_water_percent:
            break
        removed_paths += _delete_job_media(job, data_root, store)
        removed_jobs.append(job["job_id"])
        usage = shutil.disk_usage(data_root)

    orphan_files = _cleanup_orphan_uploads(
        data_root / "uploads",
        incomplete_hours * 60 * 60,
        time.time(),
    )
    final_usage = shutil.disk_usage(data_root)
    return {
        "ok": True,
        "removed_jobs": removed_jobs,
        "removed_paths": removed_paths,
        "removed_orphan_upload_files": orphan_files,
        "expired_upload_jobs": expired_upload_jobs,
        "disk_used_percent": round(final_usage.used / final_usage.total * 100, 1),
    }


def main() -> int:
    data_root = Path(os.environ.get("VIDEO2TEXT_DATA_ROOT", "/data"))
    result = run_cleanup(
        data_root,
        retention_days=int(os.environ.get("VIDEO2TEXT_MEDIA_RETENTION_DAYS", 7)),
        incomplete_hours=int(os.environ.get("VIDEO2TEXT_INCOMPLETE_UPLOAD_HOURS", 24)),
        high_water_percent=float(os.environ.get("VIDEO2TEXT_DISK_HIGH_WATER_PERCENT", 80)),
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
