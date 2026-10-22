from __future__ import annotations

import os
import base64
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

    def test_caddy_separates_public_control_and_upload_hosts(self):
        caddy = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block, remainder = caddy.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)
        upload_block, sub2api_block = remainder.split("http://:8081", 1)
        self.assertIn("{$VIDEO2TEXT_WEB_HOST}", web_block)
        protected = web_block.split("        handle @cantones {", 1)[1].split("        handle @control {", 1)[0]
        self.assertIn("basic_auth", protected)
        self.assertIn("reverse_proxy cantones:4178", protected)
        self.assertIn("@control path /api/*", web_block)
        self.assertIn("/files/*", upload_block)
        self.assertIn("/media/*", upload_block)
        self.assertNotIn("/api/*", upload_block)
        self.assertIn("/v1/*", sub2api_block)
        self.assertNotIn("/home", sub2api_block)
        self.assertIn("respond 404", sub2api_block)

    def test_caddy_redirects_root_without_authentication(self):
        caddy = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block = caddy.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)[0]
        before_route, route_tail = web_block.split("    route {\n", 1)
        route, after_route = route_tail.split("\n    }\n\n    log", 1)
        redirect = route.index("        redir / /nas 302")
        for handler in (
            "        handle @control {",
            "        handle @jobs {",
            "        handle @nas {",
            "        handle @mobile {",
            "        handle {",
        ):
            self.assertLess(redirect, route.index(handler), handler)
        public_route = route.split("        handle @control {", 1)[1]
        self.assertNotIn("basic_auth", before_route + public_route + after_route)
        self.assertEqual(route.count("basic_auth"), 1)

    @unittest.skipUnless(shutil.which("caddy"), "Caddy binary is not installed")
    def test_caddy_root_redirects_without_credentials(self):
        caddy = shutil.which("caddy")
        web_block = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web_block = web_block.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)[0]
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        web_block = web_block.replace("{$VIDEO2TEXT_WEB_HOST}", f"http://127.0.0.1:{port}")
        opener = build_opener(ProxyHandler({}), _NoRedirect())

        def request_status(path, credentials=None):
            request = Request(f"http://127.0.0.1:{port}{path}")
            if credentials is not None:
                request.add_header("Authorization", "Basic " + base64.b64encode(credentials.encode()).decode())
            try:
                with opener.open(request, timeout=30) as response:
                    return response.status, response.headers
            except HTTPError as error:
                return error.code, error.headers

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "Caddyfile"
            config.write_text("{\n    admin off\n}\n\n" + web_block, encoding="utf-8")
            environment = os.environ.copy()
            environment["VIDEO2TEXT_CANTONES_USER"] = "demo-test"
            environment["VIDEO2TEXT_CANTONES_PASSWORD_HASH"] = subprocess.check_output(
                [caddy, "hash-password", "--plaintext", "runtime-test-password"], text=True,
            ).strip()
            process = subprocess.Popen(
                [caddy, "run", "--config", str(config), "--adapter", "caddyfile"],
                env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
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
                self.assertEqual(status, 302)
                self.assertEqual(headers.get("Location"), "/nas")
                self.assertNotIn("WWW-Authenticate", headers)
                for path in ("/nas", "/api/health"):
                    status, headers = request_status(path)
                    self.assertNotEqual(status, 401)
                    self.assertNotIn("WWW-Authenticate", headers)
                for path in ("/cantones", "/cantones/", "/cantones/api/health", "/cantones/api/jobs"):
                    status, headers = request_status(path)
                    self.assertEqual(status, 401, path)
                    self.assertIn("WWW-Authenticate", headers)
                    status, headers = request_status(path, "demo-test:runtime-test-password")
                    self.assertNotEqual(status, 401, path)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


    def test_caddy_redacts_custom_credentials_and_signature(self):
        caddy = (REPO_ROOT / "deploy/nas/Caddyfile").read_text(encoding="utf-8")
        web, remainder = caddy.split("{$VIDEO2TEXT_PUBLIC_HOST}", 1)
        upload, sub2api = remainder.split("http://:8081", 1)
        for block in (web, upload, sub2api):
            self.assertIn("format filter {", block)
            self.assertIn("wrap json", block)
            self.assertIn("request>headers>X-Upload-Token delete", block)
            self.assertIn("request>headers>X-Video2Text-Proxy-Token delete", block)
            # Go canonicalizes this header to Video2text, not Video2Text.
            self.assertIn("request>headers>X-Video2text-Proxy-Token delete", block)
            self.assertIn("request>uri query {", block)
            self.assertIn("delete signature", block)
        self.assertNotIn("log_credentials", caddy)
        self.assertIn("flush_interval -1", sub2api)

    def test_verify_script_is_executable_and_non_billable(self):
        script = REPO_ROOT / "deploy/nas/verify.sh"
        self.assertTrue(os.access(script, os.X_OK))
        text = script.read_text(encoding="utf-8")
        self.assertIn("config --quiet", text)
        self.assertIn("caddy caddy validate", text)
        self.assertNotIn("compose up", text)
        self.assertNotIn("curl", text)

    def test_environment_example_uses_final_domains(self):
        environment = (REPO_ROOT / "deploy/nas/.env.example").read_text(encoding="utf-8")
        self.assertIn("VIDEO2TEXT_WEB_HOST=stt.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_PUBLIC_HOST=upload.151077.xyz", environment)
        self.assertIn("VIDEO2TEXT_SUB2API_UPSTREAM=10.0.0.218:8080", environment)

    def test_tusd_hook_backoff_uses_go_duration_syntax(self):
        compose = (REPO_ROOT / "deploy/nas/compose.yaml").read_text(encoding="utf-8")
        self.assertIn("-hooks-http-backoff=2s", compose)
        self.assertNotIn("-hooks-http-backoff=2\n", compose)

    def test_cantones_build_context_and_private_runtime_mount(self):
        compose = (REPO_ROOT / "deploy/nas/compose.yaml").read_text(encoding="utf-8")
        block = compose.split("  cantones:\n", 1)[1].split("\n  cleanup:", 1)[0]
        self.assertNotIn("ports:", block)
        self.assertIn("CANTONES_ONLY: 1", block)
        self.assertIn("CANTONES_PUBLIC_ORIGIN: https://${VIDEO2TEXT_WEB_HOST}", block)
        self.assertIn("/cantones\n", block)
        context = (REPO_ROOT / "deploy/nas" / "../../apps/cantonese-demo").resolve()
        dockerfile = (context / "../../deploy/nas/Dockerfile.cantones").resolve()
        self.assertTrue(dockerfile.is_file())
        ignore = (context / ".dockerignore").read_text(encoding="utf-8")
        self.assertTrue(ignore.startswith("*\n"))
        self.assertNotIn("!.data", ignore)
        self.assertNotIn("!config", ignore)
        self.assertIn("USER node", dockerfile.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
