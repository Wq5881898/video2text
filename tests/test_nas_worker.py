from __future__ import annotations

import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest.mock import patch

from apps.nas_worker.app import QueueWorker, WorkerSettings, create_app
from apps.nas_worker.cleanup import run_cleanup
from apps.nas_worker.security import build_signed_media_url, encode_upload_token


class NasWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.secret = "shared-secret-that-is-longer-than-32-characters"
        self.proxy_token = "proxy-token-that-is-longer-than-32-characters"
        self.settings = WorkerSettings(
            data_root=self.root,
            public_origin="https://upload.example.test",
            shared_secret=self.secret,
            proxy_token=self.proxy_token,
        )
        self.app = create_app(self.settings, start_worker=False)
        self.client = self.app.test_client()
        self.store = self.app.config["VIDEO2TEXT_STORE"]

    def tearDown(self):
        self.temp.cleanup()

    def ticket(self, job_id="nas_123456789abc", file_name="recording.m4a", file_size=4):
        payload = {
            "version": 1,
            "job_id": job_id,
            "file_name": file_name,
            "file_size": file_size,
            "content_type": "audio/mp4",
            "output_format": "txt",
            "translate": True,
            "source_language": "auto",
            "translation_provider": "minimax",
            "expires_at": int(time.time()) + 3600,
            "nonce": "test",
        }
        return payload, encode_upload_token(payload, self.secret)

    @staticmethod
    def hook_body(hook_type, token, upload_id="upload-1", size=4):
        return {
            "Type": hook_type,
            "Event": {
                "HTTPRequest": {"Header": {"X-Upload-Token": [token]}},
                "Upload": {"ID": upload_id, "Size": size},
            },
        }

    def test_local_control_plane_issues_ticket_and_exposes_status(self):
        response = self.client.post(
            "/api/nas-ticket",
            json={
                "file_name": "recording.m4a",
                "file_size": 4,
                "content_type": "audio/mp4",
                "output_format": "srt",
                "translate": True,
                "source_language": "auto",
                "translation_provider": "minimax",
            },
        )
        self.assertEqual(response.status_code, 200)
        ticket = response.get_json()
        self.assertRegex(ticket["job_id"], r"^nas_[a-f0-9]{12}$")
        self.assertEqual(ticket["upload_endpoint"], "https://upload.example.test/files/")
        payload = self.ticket(job_id=ticket["job_id"])[0]
        self.store.register_upload(payload, self.settings.max_active_jobs)
        status = self.client.get(f"/api/jobs-status?job_id={ticket['job_id']}")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.get_json()["status"], "uploading")

    def test_local_ticket_rejects_invalid_input(self):
        response = self.client.post(
            "/api/nas-ticket",
            json={"file_name": "malware.exe", "file_size": 4, "translate": False},
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.post(
            "/api/nas-ticket",
            json={"file_name": "audio.m4a", "file_size": 4, "translate": "false"},
        )
        self.assertEqual(response.status_code, 400)

    def test_tusd_hook_moves_completed_upload_and_queues_job(self):
        payload, token = self.ticket()
        response = self.client.post("/hooks/tusd", json=self.hook_body("pre-create", token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.get(payload["job_id"])["status"], "uploading")

        response = self.client.post("/hooks/tusd", json=self.hook_body("post-receive", token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.get(payload["job_id"])["upload_id"], "upload-1")

        source = self.root / "uploads" / "upload-1"
        source.write_bytes(b"test")
        (self.root / "uploads" / "upload-1.info").write_text("{}", encoding="utf-8")
        response = self.client.post("/hooks/tusd", json=self.hook_body("post-finish", token))
        self.assertEqual(response.status_code, 200)

        job = self.store.get(payload["job_id"])
        target = self.root / "media" / payload["job_id"] / payload["file_name"]
        self.assertEqual(job["status"], "queued")
        self.assertEqual(Path(job["source_path"]), target)
        self.assertEqual(target.read_bytes(), b"test")
        self.assertFalse(source.exists())

    def test_post_finish_failure_returns_http_error_for_tusd_retry(self):
        _, token = self.ticket()
        response = self.client.post("/hooks/tusd", json=self.hook_body("post-finish", token))
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["error"], "completed upload file is missing")

    def test_status_requires_private_proxy_token(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        self.assertEqual(self.client.get(f"/api/jobs/{payload['job_id']}").status_code, 401)
        response = self.client.get(
            f"/api/jobs/{payload['job_id']}",
            headers={"X-Video2Text-Proxy-Token": self.proxy_token},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["backend"], "nas")

    def test_signed_media_url_supports_range_reads(self):
        media = self.root / "media" / "nas_123456789abc" / "recording.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"0123456789")
        signed = build_signed_media_url(
            media,
            data_root=self.root,
            public_origin=self.settings.public_origin,
            secret=self.secret,
            ttl_seconds=3600,
        )
        parsed = urlsplit(signed)
        response = self.client.get(f"{parsed.path}?{parsed.query}", headers={"Range": "bytes=2-5"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, b"2345")
        response.close()

    def test_worker_completion_immediately_removes_media_and_retains_result(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        media = self.root / "media" / payload["job_id"] / payload["file_name"]
        media.parent.mkdir(parents=True)
        media.write_bytes(b"test")
        self.store.enqueue(payload["job_id"], "upload-1", media)
        job = self.store.claim_next()
        self.assertIsNotNone(job)

        def fake_process(source_path, config, **_kwargs):
            config.output_dir.mkdir(parents=True, exist_ok=True)
            config.jobs_root.mkdir(parents=True, exist_ok=True)
            (config.jobs_root / "checkpoint.json").write_text("{}", encoding="utf-8")
            output = config.output_dir / "recording.txt"
            output.write_text("transcript", encoding="utf-8")
            return SimpleNamespace(output_path=output, translated=True, media_type="audio")

        worker = QueueWorker(self.settings, self.store)
        with patch("apps.nas_worker.app.process_one", side_effect=fake_process):
            worker.process(job)

        completed = self.store.get(payload["job_id"])
        result = self.root / "results" / payload["job_id"] / "recording.txt"
        self.assertEqual(completed["status"], "completed")
        self.assertIsNotNone(completed["media_deleted_at"])
        self.assertFalse(media.parent.exists())
        self.assertFalse((self.root / "work" / payload["job_id"]).exists())
        self.assertEqual(result.read_text(encoding="utf-8"), "transcript")

    def test_cleanup_failure_does_not_change_completed_result_to_failed(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        media = self.root / "media" / payload["job_id"] / payload["file_name"]
        media.parent.mkdir(parents=True)
        media.write_bytes(b"test")
        self.store.enqueue(payload["job_id"], "upload-1", media)
        job = self.store.claim_next()

        def fake_process(source_path, config, **_kwargs):
            config.output_dir.mkdir(parents=True, exist_ok=True)
            output = config.output_dir / "recording.txt"
            output.write_text("transcript", encoding="utf-8")
            return SimpleNamespace(output_path=output, translated=False, media_type="audio")

        worker = QueueWorker(self.settings, self.store)
        with (
            patch("apps.nas_worker.app.process_one", side_effect=fake_process),
            patch("apps.nas_worker.app.delete_job_media", side_effect=OSError("busy")),
        ):
            worker.process(job)
        self.assertEqual(self.store.get(payload["job_id"])["status"], "completed")

    def test_cleanup_removes_expired_media_but_retains_result(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        media = self.root / "media" / payload["job_id"] / payload["file_name"]
        media.parent.mkdir(parents=True)
        media.write_bytes(b"test")
        self.store.enqueue(payload["job_id"], "upload-1", media)
        result = self.root / "results" / payload["job_id"] / "recording.txt"
        result.parent.mkdir(parents=True)
        result.write_text("transcript", encoding="utf-8")
        work = self.root / "work" / payload["job_id"]
        work.mkdir(parents=True)
        (work / "checkpoint.json").write_text("{}", encoding="utf-8")
        self.store.complete(
            payload["job_id"],
            result_path=result,
            output_filename="recording.txt",
            translated=True,
            media_type="audio",
        )
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat().replace("+00:00", "Z")
        with self.store.connection() as connection:
            connection.execute("UPDATE jobs SET updated_at = ? WHERE job_id = ?", (old, payload["job_id"]))

        cleanup = run_cleanup(self.root, retention_days=7, high_water_percent=101)
        self.assertEqual(cleanup["removed_jobs"], [payload["job_id"]])
        self.assertFalse(media.parent.exists())
        self.assertFalse(work.exists())
        self.assertEqual(result.read_text(encoding="utf-8"), "transcript")

    def test_cleanup_expires_abandoned_upload_and_releases_queue_slot(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        partial = self.root / "uploads" / "upload-1"
        info = self.root / "uploads" / "upload-1.info"
        partial.write_bytes(b"partial")
        info.write_text("{}", encoding="utf-8")
        old_timestamp = time.time() - 25 * 60 * 60
        os.utime(partial, (old_timestamp, old_timestamp))
        os.utime(info, (old_timestamp, old_timestamp))
        old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat().replace("+00:00", "Z")
        with self.store.connection() as connection:
            connection.execute(
                "UPDATE jobs SET upload_id = ?, updated_at = ? WHERE job_id = ?",
                ("upload-1", old, payload["job_id"]),
            )

        cleanup = run_cleanup(self.root, incomplete_hours=24, high_water_percent=101)
        self.assertEqual(cleanup["expired_upload_jobs"], [payload["job_id"]])
        self.assertEqual(cleanup["removed_orphan_upload_files"], 2)
        self.assertEqual(self.store.get(payload["job_id"])["status"], "failed")
        self.assertEqual(self.store.active_count(), 0)

    def test_cleanup_removes_media_moved_before_enqueue(self):
        payload, _ = self.ticket()
        self.store.register_upload(payload, self.settings.max_active_jobs)
        media_dir = self.root / "media" / payload["job_id"]
        media_dir.mkdir(parents=True)
        (media_dir / payload["file_name"]).write_bytes(b"orphaned-after-move")
        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat().replace("+00:00", "Z")
        with self.store.connection() as connection:
            connection.execute(
                "UPDATE jobs SET status = 'failed', updated_at = ? WHERE job_id = ?",
                (old, payload["job_id"]),
            )

        cleanup = run_cleanup(self.root, retention_days=7, high_water_percent=101)
        self.assertEqual(cleanup["removed_jobs"], [payload["job_id"]])
        self.assertFalse(media_dir.exists())


if __name__ == "__main__":
    unittest.main()
