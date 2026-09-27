from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class NasDeployConfigTests(unittest.TestCase):
    def test_compose_exposes_only_edge_ports_and_mounts_static_web(self):
        compose = (REPO_ROOT / "deploy/nas/compose.yaml").read_text(encoding="utf-8")
        self.assertIn('"80:80"', compose)
        self.assertIn('"443:443"', compose)
        self.assertIn('"127.0.0.1:8081:8081"', compose)
        self.assertIn("../../apps/web/public:/srv/video2text-web:ro", compose)
        worker_block = compose.split("  worker:\n", 1)[1].split("\n  cleanup:", 1)[0]
        self.assertNotIn("ports:", worker_block)

    def test_caddy_separates_authenticated_control_and_upload_hosts(self):
        caddy = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block, remainder = caddy.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)
        upload_block, sub2api_block = remainder.split("http://:8081", 1)
        self.assertIn("{$VIDEO2TEXT_WEB_HOST}", web_block)
        self.assertIn("basic_auth", web_block)
        self.assertIn("@control path /api/*", web_block)
        self.assertIn("/files/*", upload_block)
        self.assertIn("/media/*", upload_block)
        self.assertNotIn("/api/*", upload_block)
        self.assertIn("/v1/*", sub2api_block)
        self.assertNotIn("/home", sub2api_block)
        self.assertIn("respond 404", sub2api_block)

    def test_environment_example_uses_final_domains(self):
        environment = (REPO_ROOT / "deploy/nas/.env.example").read_text(encoding="utf-8")
        self.assertIn("VIDEO2TEXT_WEB_HOST=stt.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_PUBLIC_HOST=upload.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_SUB2API_UPSTREAM=10.0.0.218:8080", environment)


if __name__ == "__main__":
    unittest.main()
