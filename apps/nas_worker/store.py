from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class JobStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._schema_lock = threading.Lock()
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    @contextmanager
    def connection(self):
        connection = self.connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._schema_lock, self.connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    upload_id TEXT,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    message TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    content_type TEXT NOT NULL,
                    output_format TEXT NOT NULL,
                    translate INTEGER NOT NULL,
                    source_language TEXT NOT NULL,
                    translation_provider TEXT NOT NULL,
                    source_path TEXT,
                    result_path TEXT,
                    output_filename TEXT,
                    translated INTEGER,
                    media_type TEXT,
                    error TEXT,
                    recent_log TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    media_deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS jobs_cleanup_idx ON jobs(media_deleted_at, updated_at);
                """
            )

    @staticmethod
    def _as_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        result["translate"] = bool(result["translate"])
        if result.get("translated") is not None:
            result["translated"] = bool(result["translated"])
        return result

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._as_dict(connection.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone())

    def active_count(self) -> int:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('uploading', 'queued', 'processing')"
            ).fetchone()
            return int(row["count"])

    def register_upload(self, ticket: dict[str, Any], max_active_jobs: int) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (ticket["job_id"],)
            ).fetchone()
            if existing is not None:
                job = self._as_dict(existing)
                if job["status"] != "uploading" or job["file_size"] != int(ticket["file_size"]):
                    raise ValueError("job ticket has already been used")
                connection.commit()
                return job
            active = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('uploading', 'queued', 'processing')"
            ).fetchone()["count"]
            if int(active) >= max_active_jobs:
                raise ValueError("the NAS queue is currently full")
            connection.execute(
                """
                INSERT INTO jobs (
                    job_id, status, stage, message, file_name, file_size, content_type,
                    output_format, translate, source_language, translation_provider,
                    created_at, updated_at
                ) VALUES (?, 'uploading', 'uploading', 'Waiting for the resumable upload.', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ticket["job_id"],
                    ticket["file_name"],
                    int(ticket["file_size"]),
                    ticket.get("content_type") or "application/octet-stream",
                    ticket["output_format"],
                    int(bool(ticket["translate"])),
                    ticket["source_language"],
                    ticket["translation_provider"],
                    now,
                    now,
                ),
            )
            connection.commit()
        job = self.get(ticket["job_id"])
        if job is None:
            raise RuntimeError("registered upload disappeared")
        return job

    def enqueue(self, job_id: str, upload_id: str, source_path: Path) -> None:
        now = utc_now()
        with self.connection() as connection:
            changed = connection.execute(
                """
                UPDATE jobs SET upload_id = ?, source_path = ?, status = 'queued', stage = 'queued',
                    message = 'Upload complete. Waiting for the single processing worker.', updated_at = ?
                WHERE job_id = ? AND status IN ('uploading', 'queued')
                """,
                (upload_id, str(source_path), now, job_id),
            ).rowcount
            if changed == 0:
                existing = connection.execute("SELECT status FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
                if existing is None:
                    raise ValueError("upload job was not registered")

    def touch_upload(self, job_id: str, upload_id: str) -> None:
        with self.connection() as connection:
            connection.execute(
                """
                UPDATE jobs SET upload_id = ?, updated_at = ?
                WHERE job_id = ? AND status = 'uploading'
                """,
                (upload_id, utc_now(), job_id),
            )

    def expire_abandoned_uploads(self, cutoff: str) -> list[str]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT job_id FROM jobs WHERE status = 'uploading' AND updated_at < ? ORDER BY updated_at",
                (cutoff,),
            ).fetchall()
            job_ids = [str(row["job_id"]) for row in rows]
            if job_ids:
                placeholders = ",".join("?" for _ in job_ids)
                connection.execute(
                    f"""
                    UPDATE jobs SET status = 'failed', stage = 'upload_expired',
                        message = 'The incomplete upload expired after 24 hours.',
                        error = 'Incomplete upload expired before processing could start.',
                        updated_at = ? WHERE job_id IN ({placeholders})
                    """,
                    (utc_now(), *job_ids),
                )
            return job_ids

    def recover_interrupted(self) -> int:
        now = utc_now()
        with self.connection() as connection:
            return connection.execute(
                """
                UPDATE jobs SET status = 'queued', stage = 'recovered',
                    message = 'Worker restarted. Resuming from saved checkpoints.', updated_at = ?
                WHERE status = 'processing'
                """,
                (now,),
            ).rowcount

    def claim_next(self) -> dict[str, Any] | None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            changed = connection.execute(
                """
                UPDATE jobs SET status = 'processing', stage = 'starting',
                    message = 'The Ubuntu worker is starting this task.', updated_at = ?
                WHERE job_id = ? AND status = 'queued'
                """,
                (now, row["job_id"]),
            ).rowcount
            connection.commit()
            return self.get(row["job_id"]) if changed else None

    def update_stage(self, job_id: str, stage: str, message: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "UPDATE jobs SET stage = ?, message = ?, updated_at = ? WHERE job_id = ?",
                (stage, message, utc_now(), job_id),
            )

    def append_log(self, job_id: str, message: str) -> None:
        with self.connection() as connection:
            row = connection.execute("SELECT recent_log FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            previous = row["recent_log"] if row else ""
            combined = f"{previous}\n{message}".strip()
            connection.execute(
                "UPDATE jobs SET recent_log = ?, updated_at = ? WHERE job_id = ?",
                (combined[-32000:], utc_now(), job_id),
            )

    def complete(
        self,
        job_id: str,
        *,
        result_path: Path,
        output_filename: str,
        translated: bool,
        media_type: str,
    ) -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                """
                UPDATE jobs SET status = 'completed', stage = 'done', message = 'Transcript is ready.',
                    result_path = ?, output_filename = ?, translated = ?, media_type = ?,
                    error = NULL, completed_at = ?, updated_at = ? WHERE job_id = ?
                """,
                (str(result_path), output_filename, int(translated), media_type, now, now, job_id),
            )

    def fail(self, job_id: str, error: str) -> None:
        with self.connection() as connection:
            connection.execute(
                """
                UPDATE jobs SET status = 'failed', stage = 'failed',
                    message = 'The NAS worker could not complete this task.', error = ?, updated_at = ?
                WHERE job_id = ?
                """,
                (error[:4000], utc_now(), job_id),
            )

    def cleanup_candidates(self, cutoff: str, *, ignore_cutoff: bool = False) -> list[dict[str, Any]]:
        query = (
            "SELECT * FROM jobs WHERE status IN ('completed', 'failed') AND media_deleted_at IS NULL "
            + ("" if ignore_cutoff else "AND updated_at < ? ")
            + "ORDER BY updated_at"
        )
        parameters = () if ignore_cutoff else (cutoff,)
        with self.connection() as connection:
            return [self._as_dict(row) for row in connection.execute(query, parameters).fetchall()]

    def mark_media_deleted(self, job_id: str) -> None:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "UPDATE jobs SET media_deleted_at = ?, updated_at = ? WHERE job_id = ?",
                (now, now, job_id),
            )

    def public_status(self, job_id: str) -> dict[str, Any] | None:
        job = self.get(job_id)
        if job is None:
            return None
        result = {
            "ok": True,
            "job_id": job["job_id"],
            "status": job["status"],
            "stage": job["stage"],
            "message": job["message"],
            "updated_at": job["updated_at"],
            "created_at": job["created_at"],
            "backend": "nas",
        }
        if job.get("error"):
            result["error"] = job["error"]
        if job.get("recent_log"):
            result["recent_log"] = job["recent_log"]
        if job["status"] == "completed":
            result["completed_at"] = job["completed_at"]
            result["result"] = {
                "output_filename": job["output_filename"],
                "translated": job["translated"],
                "media_type": job["media_type"],
            }
        return result

    def public_result(self, job_id: str) -> dict[str, Any] | None:
        job = self.get(job_id)
        if job is None or job["status"] != "completed" or not job.get("result_path"):
            return None
        result_path = Path(job["result_path"])
        return {
            "ok": True,
            "job_id": job_id,
            "completed_at": job["completed_at"],
            "output_filename": job["output_filename"],
            "output_text": result_path.read_text(encoding="utf-8"),
            "translated": job["translated"],
            "media_type": job["media_type"],
        }
