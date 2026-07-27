from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from urllib.parse import urlparse
from flask import Flask, jsonify, request as flask_request


_SHARED_PATH = Path(__file__).resolve().parent / "_shared.py"
_SHARED_SPEC = importlib.util.spec_from_file_location("_web_shared", _SHARED_PATH)
_SHARED = importlib.util.module_from_spec(_SHARED_SPEC)
assert _SHARED_SPEC is not None and _SHARED_SPEC.loader is not None
_SHARED_SPEC.loader.exec_module(_SHARED)

REPO_ROOT = _SHARED.REPO_ROOT
WEB_JOBS_ROOT = _SHARED.WEB_JOBS_ROOT
WEB_OUTPUTS_ROOT = _SHARED.WEB_OUTPUTS_ROOT
WEB_UPLOADS_ROOT = _SHARED.WEB_UPLOADS_ROOT
ensure_runtime_dirs = _SHARED.ensure_runtime_dirs
make_job_id = _SHARED.make_job_id

_CORE_PATH = Path(__file__).resolve().parent / "web_core.py"
_CORE_SPEC = importlib.util.spec_from_file_location("_web_core", _CORE_PATH)
_CORE = importlib.util.module_from_spec(_CORE_SPEC)
assert _CORE_SPEC is not None and _CORE_SPEC.loader is not None
_CORE_SPEC.loader.exec_module(_CORE)
OUTPUT_FORMATS = _CORE.OUTPUT_FORMATS
SUPPORTED_EXTS = _CORE.SUPPORTED_EXTS
classify_media = _CORE.classify_media

_PIPELINE_PATH = Path(__file__).resolve().parent / "cloud_pipeline.py"
_PIPELINE_SPEC = importlib.util.spec_from_file_location("_cloud_pipeline", _PIPELINE_PATH)
_PIPELINE = importlib.util.module_from_spec(_PIPELINE_SPEC)
assert _PIPELINE_SPEC is not None and _PIPELINE_SPEC.loader is not None
_PIPELINE_SPEC.loader.exec_module(_PIPELINE)
process_media = _PIPELINE.process_media


def _json_from_request(request) -> dict:
    if request is None:
        return {}
    body = getattr(request, "body", None)
    if body is None:
        return {}
    if isinstance(body, bytes):
        raw = body.decode("utf-8")
    else:
        raw = str(body)
    return json.loads(raw or "{}")


def _payload_from_request(request) -> dict:
    form = getattr(request, "form", None) or {}
    if form:
        return dict(form)
    return _json_from_request(request)
def _validate_source_url(value: str) -> str | None:
    if not value:
        return "source_url is required"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return "source_url must start with http:// or https://"
    if not parsed.netloc:
        return "source_url host is missing"
    return None


def _build_request_payload(
    *,
    input_mode: str,
    source_url: str,
    file_name: str,
    file_size,
    file_type,
    output_format: str,
    translate: bool,
) -> dict[str, object]:
    return {
        "input_mode": input_mode,
        "source_url": source_url or None,
        "file_name": file_name or None,
        "file_size": int(file_size) if file_size not in (None, "") else None,
        "file_type": file_type or None,
        "output_format": output_format,
        "translate": translate,
    }


def _request_from_flask():
    class Request:
        pass

    req = Request()
    req.method = flask_request.method
    req.body = flask_request.get_data()
    req.form = dict(flask_request.form)
    req.files = {}
    uploaded = flask_request.files.get("source_file")
    if uploaded is not None:
        req.files["source_file"] = {
            "filename": uploaded.filename,
            "content": uploaded.read(),
            "content_type": uploaded.content_type,
        }
    return req


def handler(request=None):
    payload = _payload_from_request(request)
    input_mode = str(payload.get("input_mode", "upload")).strip().lower()
    source_url = str(payload.get("source_url", "")).strip()
    file_name = str(payload.get("file_name", "")).strip()
    file_size = payload.get("file_size")
    file_type = payload.get("file_type")
    output_format = str(payload.get("output_format", "txt")).strip().lower()
    translate = bool(payload.get("translate", True))
    uploaded_file = (getattr(request, "files", None) or {}).get("source_file")

    errors: list[str] = []
    if input_mode not in {"upload", "url"}:
        errors.append("input_mode must be one of: upload, url")
    elif input_mode == "url":
        source_error = _validate_source_url(source_url)
        if source_error:
            errors.append(source_error)
    elif input_mode == "upload":
        if uploaded_file is not None:
            upload_name = str(uploaded_file.get("filename", "")).strip()
            upload_size = len(bytes(uploaded_file.get("content", b"")))
            if not upload_name:
                errors.append("uploaded file name is missing")
            if upload_size <= 0:
                errors.append("uploaded file is empty")
        else:
            if not file_name:
                errors.append("file_name is required when input_mode=upload")
            if file_size in (None, ""):
                errors.append("file_size is required when input_mode=upload")
            else:
                try:
                    if int(file_size) <= 0:
                        errors.append("file_size must be greater than 0")
                except (TypeError, ValueError):
                    errors.append("file_size must be an integer")

    if output_format not in OUTPUT_FORMATS:
        errors.append(f"output_format must be one of: {', '.join(sorted(OUTPUT_FORMATS))}")

    if errors:
        return {
            "ok": False,
            "surface": "web",
            "status": "invalid_request",
            "errors": errors,
        }

    request_data = _build_request_payload(
        input_mode=input_mode,
        source_url=source_url,
        file_name=file_name,
        file_size=file_size,
        file_type=file_type,
        output_format=output_format,
        translate=translate,
    )

    try:
        if input_mode == "upload" and uploaded_file is None:
            return {
                "ok": True,
                "surface": "web",
                "status": "validated_only",
                "message": "Request contract accepted, but no uploaded bytes were received in this runtime.",
                "request": request_data,
            }

        file_bytes = None if uploaded_file is None else bytes(uploaded_file.get("content", b""))
        file_content_type = None if uploaded_file is None else uploaded_file.get("content_type")
        source_name = str(uploaded_file.get("filename", file_name)) if uploaded_file is not None else file_name
        result = process_media(
            input_mode=input_mode,
            output_format=output_format,
            translate=translate,
            file_name=source_name,
            file_bytes=file_bytes,
            file_content_type=None if file_content_type is None else str(file_content_type),
            source_url=source_url or None,
        )
        return {
            "ok": True,
            "surface": "web",
            "status": "completed",
            "message": "Media processed successfully in the cloud runtime.",
            "request": request_data,
            "result": {
                **result,
                "repo_root": str(REPO_ROOT),
                "execution_mode": "sync-direct",
            },
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "surface": "web",
            "status": "processing_failed",
            "error": str(exc),
        }


app = Flask(__name__)


@app.route("/api/transcribe", methods=["POST"])
@app.route("/", methods=["POST"])
def transcribe_route():
    payload_dict = handler(_request_from_flask())
    status_code = 200 if payload_dict.get("ok") else 400
    return jsonify(payload_dict), status_code
