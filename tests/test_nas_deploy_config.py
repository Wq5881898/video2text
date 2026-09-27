from __future__ import annotations

import base64
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


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

    def test_caddy_authenticates_before_root_redirect_and_web_handlers(self):
        caddy = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block = caddy.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)[0]
        before_route, route_tail = web_block.split("    route {\n", 1)
        route, after_route = route_tail.split("\n    }\n\n    log", 1)

        auth = route.index("        basic_auth {")
        redirect = route.index("        redir / /nas 302")
        self.assertLess(auth, redirect)
        for handler in (
            "        handle @control {",
            "        handle @jobs {",
            "        handle @nas {",
            "        handle @mobile {",
            "        handle {",
        ):
            self.assertLess(redirect, route.index(handler), handler)
        self.assertNotIn("basic_auth", before_route + after_route)
        self.assertNotIn("redir / /nas 302", before_route + after_route)

    @unittest.skipUnless(shutil.which("caddy"), "Caddy binary is not installed")
    def test_caddy_root_returns_401_before_authenticated_redirect(self):
        caddy = shutil.which("caddy")
        web_block = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block = web_block.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)[0]
        password_hash = subprocess.check_output(
            [caddy, "hash-password", "--plaintext", "test-password"], text=True
        ).strip()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        web_block = web_block.replace("{$VIDEO2TEXT_WEB_HOST}", f"http://127.0.0.1:{port}")
        environment = os.environ.copy()
        environment.update(
            VIDEO2TEXT_WEB_USER="test-user",
            VIDEO2TEXT_WEB_PASSWORD_HASH=password_hash,
        )
        opener = build_opener(ProxyHandler({}), _NoRedirect())

        def request_status(path, authorization=None):
            headers = {"Authorization": authorization} if authorization else {}
            request = Request(f"http://127.0.0.1:{port}{path}", headers=headers)
            try:
                with opener.open(request, timeout=30) as response:
                    return response.status, response.headers
            except HTTPError as error:
                return error.code, error.headers

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "Caddyfile"
            config.write_text("{\n    admin off\n}\n\n" + web_block, encoding="utf-8")
            process = subprocess.Popen(
                [caddy, "run", "--config", str(config), "--adapter", "caddyfile"],
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while True:
                    if process.poll() is not None:
                        self.fail(f"Caddy exited during startup: {process.returncode}")
                    try:
                        status, headers = request_status("/")
                        break
                    except URLError:
                        if time.monotonic() >= deadline:
                            self.fail("Caddy did not start within 10 seconds")
                        time.sleep(0.1)

                self.assertEqual(status, 401)
                self.assertIn("Basic", headers.get("WWW-Authenticate", ""))
                self.assertEqual(request_status("/nas")[0], 401)
                self.assertEqual(request_status("/api/test")[0], 401)
                token = base64.b64encode(b"test-user:test-password").decode("ascii")
                status, headers = request_status("/", f"Basic {token}")
                self.assertEqual(status, 302)
                self.assertEqual(headers.get("Location"), "/nas")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    def test_environment_example_uses_final_domains(self):
        environment = (REPO_ROOT / "deploy/nas/.env.example").read_text(encoding="utf-8")
        self.assertIn("VIDEO2TEXT_WEB_HOST=stt.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_PUBLIC_HOST=upload.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_SUB2API_UPSTREAM=10.0.0.218:8080", environment)

    def test_tusd_hook_backoff_uses_go_duration_syntax(self):
        compose = (REPO_ROOT / "deploy/nas/compose.yaml").read_text(encoding="utf-8")
        self.assertIn("-hooks-http-backoff=2s", compose)
        self.assertNotIn("-hooks-http-backoff=2\n", compose)


if __name__ == "__main__":
    unittest.main()
