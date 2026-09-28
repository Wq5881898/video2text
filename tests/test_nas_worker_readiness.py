from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from apps.nas_worker.app import WorkerSettings, create_app
from apps.nas_worker.security import decode_upload_token


class WorkerReadinessTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.dict(os.environ, {}, clear=True))
        # No real credentials or provider calls, including accidental network probes.
        self.network = self.stack.enter_context(patch("socket.socket.connect", side_effect=AssertionError("network forbidden")))
        self.http = self.stack.enter_context(patch("urllib.request.urlopen", side_effect=AssertionError("provider request forbidden")))
        self.gladia = self.stack.enter_context(patch("apps.nas_worker.app.read_gladia_keys", return_value=["test-only-key"]))
        self.translation = self.stack.enter_context(patch(
            "apps.nas_worker.app.read_translation_config",
            return_value={"api_key": "test-only-secret", "base_url": "https://provider.invalid/v1", "model": "test-model"},
        ))
        self.settings = WorkerSettings(
            data_root=Path(root), public_origin="https://upload.example.test",
            shared_secret="s" * 32, proxy_token="p" * 32,
        )
        self.client = create_app(self.settings, start_worker=False).test_client()

    def tearDown(self):
        self.network.assert_not_called()
        self.http.assert_not_called()

    def ticket(self, **overrides):
        return self.client.post("/api/nas-ticket", json={"file_name": "test.wav", "file_size": 4, **overrides})

    def test_default_and_deduplicated_enable_list(self):
        self.assertEqual(WorkerSettings.from_env().enabled_translation_providers, ("minimax",))
        with patch.dict(os.environ, {"VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS": " glm, minimax,glm,QWEN, ,minimax "}):
            self.assertEqual(WorkerSettings.from_env().enabled_translation_providers, ("glm", "minimax", "qwen"))
        with patch.dict(os.environ, {"VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS": " , "}):
            self.assertEqual(WorkerSettings.from_env().enabled_translation_providers, ())

    def test_unknown_provider_is_clear_startup_error(self):
        with patch.dict(os.environ, {"VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS": "minimax,unknown"}):
            with self.assertRaisesRegex(RuntimeError, "VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS.*unknown"):
                create_app(start_worker=False)
        self.settings.enabled_translation_providers = ("unknown",)
        with self.assertRaisesRegex(RuntimeError, "unknown provider"):
            create_app(self.settings, start_worker=False)

    def test_capabilities_only_enabled_and_locally_ready(self):
        response = self.client.get("/api/capabilities")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["translation_providers"], ["minimax"])
        self.assertTrue(response.json["ready"])
        self.translation.assert_called_once_with("minimax")
        self.settings.enabled_translation_providers = ("glm", "qwen")
        self.assertEqual(self.client.get("/api/capabilities").json["translation_providers"], ["glm", "qwen"])

    def test_translating_ticket_rejects_disabled_provider(self):
        for provider in ("glm", "qwen"):
            with self.subTest(provider=provider):
                response = self.ticket(translate=True, translation_provider=provider)
                self.assertEqual(response.status_code, 400)
                self.assertIn("disabled", response.json["error"])
        self.assertEqual(self.ticket(translate=True).status_code, 200)
        self.settings.enabled_translation_providers = ("glm",)
        self.assertEqual(self.ticket(translate=True, translation_provider="glm").status_code, 200)
        self.assertEqual(self.ticket().status_code, 400)

    def test_transcription_only_accepts_disabled_default_or_explicit_provider(self):
        self.settings.enabled_translation_providers = ()
        for extra in ({}, {"translation_provider": "minimax"}, {"translation_provider": "glm"}, {"translation_provider": "qwen"}):
            response = self.ticket(translate=False, **extra)
            self.assertEqual(response.status_code, 200)
            payload = decode_upload_token(response.json["upload_token"], self.settings.shared_secret)
            self.assertFalse(payload["translate"])
        self.assertEqual(self.ticket(translate=False, translation_provider="unknown").status_code, 400)
        self.assertEqual(self.ticket(translate="false").status_code, 400)

    def test_public_health_is_minimal_without_config_or_disk_probes(self):
        with patch("apps.nas_worker.app._local_readiness", side_effect=AssertionError("private check")), patch(
            "apps.nas_worker.app.shutil.disk_usage", side_effect=AssertionError("private disk check")
        ):
            response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True, "service": "video2text-nas-worker"})
        self.translation.assert_not_called()
        self.gladia.assert_not_called()

    def test_private_health_details_do_not_leak_config(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["ready"])
        self.assertEqual(response.json["checks"], {"gladia_configured": True, "minimax_configured": True, "data_writable": True})
        self.assertEqual(response.json["active_jobs"], 0)
        self.assertIsInstance(response.json["disk_used_percent"], (float, int))
        for private_value in ("test-only", "provider.invalid", "test-model", str(self.settings.data_root)):
            self.assertNotIn(private_value, response.get_data(as_text=True))

    def test_missing_gladia_changes_readiness_and_env_key_is_accepted(self):
        self.gladia.return_value = []
        self.assertFalse(self.client.get("/api/capabilities").json["ready"])
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json["checks"]["gladia_configured"])
        with patch.dict(os.environ, {"GLADIA_API_KEY": "test-only-env-key"}):
            self.assertTrue(self.client.get("/api/capabilities").json["ready"])

    def test_enabled_provider_requires_key_endpoint_and_model(self):
        for field in ("api_key", "base_url", "model"):
            with self.subTest(field=field):
                self.translation.return_value = dict.fromkeys(("api_key", "base_url", "model"), "configured")
                self.translation.return_value[field] = ""
                self.assertFalse(self.client.get("/api/capabilities").json["ready"])
        self.settings.enabled_translation_providers = ()
        self.translation.reset_mock()
        self.assertTrue(self.client.get("/api/capabilities").json["ready"])
        self.translation.assert_not_called()

    def test_unreadable_or_malformed_config_is_not_ready_or_disclosed(self):
        for error in (OSError("private-path"), ValueError("private-content"), AttributeError("malformed-json")):
            with self.subTest(error=type(error)):
                self.translation.side_effect = error
                response = self.client.get("/api/health")
                self.assertEqual(response.status_code, 503)
                self.assertFalse(response.json["checks"]["minimax_configured"])
                self.assertNotIn(str(error), response.get_data(as_text=True))
        self.translation.side_effect = None
        self.gladia.side_effect = OSError("private-path")
        self.assertFalse(self.client.get("/api/capabilities").json["ready"])

    def test_unwritable_data_changes_readiness_without_leaking_paths(self):
        with patch("apps.nas_worker.app.tempfile.TemporaryFile", side_effect=PermissionError("private-path")):
            response = self.client.get("/api/health")
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.json["checks"]["data_writable"])
            self.assertFalse(self.client.get("/api/capabilities").json["ready"])
            self.assertNotIn("private-path", response.get_data(as_text=True))
        self.assertTrue(self.client.get("/api/capabilities").json["ready"])

    def test_all_work_directories_are_write_checked_without_probe_leftovers(self):
        for directory in ("uploads", "media", "work", "results", "state"):
            with self.subTest(directory=directory):
                target = self.settings.data_root / directory
                before = set(target.iterdir())
                self.assertTrue(self.client.get("/api/capabilities").json["ready"])
                self.assertEqual(set(target.iterdir()), before)
        (self.settings.data_root / "results").rmdir()
        self.assertFalse(self.client.get("/api/capabilities").json["ready"])


if __name__ == "__main__":
    unittest.main()
