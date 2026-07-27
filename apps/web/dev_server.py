from __future__ import annotations

import cgi
import importlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent


class WebDevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json_response(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _dispatch_api(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path.removeprefix("/api/").strip("/")
        if not route:
            self._json_response(404, {"ok": False, "error": "Missing API route"})
            return
        module_name = f"api.{route.replace('/', '.')}"
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError:
            self._json_response(404, {"ok": False, "error": f"Unknown API route: {route}"})
            return

        if self.command == "POST":
            content_type = self.headers.get("Content-Type", "")
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""

            class Request:
                def __init__(self, payload: bytes, headers, query: dict, form: dict | None = None, files: dict | None = None) -> None:
                    self.body = payload
                    self.headers = headers
                    self.query = query
                    self.form = form or {}
                    self.files = files or {}

            form_data: dict[str, object] = {}
            file_data: dict[str, dict[str, object]] = {}
            if content_type.startswith("multipart/form-data"):
                environ = {
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                    "CONTENT_LENGTH": str(length),
                }
                from io import BytesIO

                form = cgi.FieldStorage(
                    fp=BytesIO(body),
                    headers=self.headers,
                    environ=environ,
                )
                if form.list:
                    for field in form.list:
                        if field.filename:
                            file_data[field.name] = {
                                "filename": field.filename,
                                "content_type": field.type,
                                "content": field.file.read(),
                            }
                        else:
                            form_data[field.name] = field.value

            request = Request(body, self.headers, parse_qs(parsed.query), form=form_data, files=file_data)
        else:
            class Request:
                def __init__(self, query: dict, headers) -> None:
                    self.body = b""
                    self.headers = headers
                    self.query = query
                    self.form = {}
                    self.files = {}

            request = Request(parse_qs(parsed.query), self.headers)

        payload = module.handler(request)
        status = 200 if payload.get("ok", False) else 400
        self._json_response(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            self.path = "/index.html"
        if self.path.startswith("/api/"):
            self._dispatch_api()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            self._dispatch_api()
            return
        self._json_response(405, {"ok": False, "error": "POST not supported for this route"})


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 3100), WebDevHandler)
    print("web dev server: http://127.0.0.1:3100", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
