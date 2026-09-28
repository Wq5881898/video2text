from __future__ import annotations

import hmac
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import traceback
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, request, send_file

from packages.shared_core import PipelineConfig, process_one
from packages.shared_core.key_management import GLADIA_KEYS_PATH, read_gladia_keys, read_translation_config

from .cleanup import delete_job_media
from .security import (
    TokenError,
    build_signed_media_url,
    decode_upload_token,
    encode_upload_token,
    verify_media_signature,
)
from .store import JobStore


JOB_ID_PATTERN = re.compile(r"^nas_[a-f0-9]{12}$")
SUPPORTED_SUFFIXES = {
    ".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b",
    ".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v",
}
SUPPORTED_OUTPUT_FORMATS = {"txt", "srt"}
SUPPORTED_SOURCE_LANGUAGES = {"auto", "en", "zh", "en_zh"}
SUPPORTED_TRANSLATION_PROVIDERS = {"minimax", "glm", "qwen"}
DATA_DIRECTORIES = ("uploads", "media", "work", "results", "state")


def _enabled_translation_providers(value: str) -> tuple[str, ...]:
    providers = tuple(dict.fromkeys(part.strip().lower() for part in value.split(",") if part.strip()))
    unknown = set(providers) - SUPPORTED_TRANSLATION_PROVIDERS
    if unknown:
        raise RuntimeError(
            "VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS contains unknown provider(s): "
            + ", ".join(sorted(unknown))
            + "; supported providers: minimax, glm, qwen"
        )
    return providers


@dataclass(slots=True)
class WorkerSettings:
    data_root: Path
    public_origin: str
    shared_secret: str
    proxy_token: str
    max_upload_bytes: int = 5 * 1024 * 1024 * 1024
    max_active_jobs: int = 4
    upload_token_ttl_seconds: int = 24 * 60 * 60
    media_url_ttl_seconds: int = 24 * 60 * 60
    poll_interval: int = 8
    poll_max_iters: int = 900
    enabled_translation_providers: tuple[str, ...] = ("minimax",)

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        return cls(
            data_root=Path(os.environ.get("VIDEO2TEXT_DATA_ROOT", "/data")),
            public_origin=os.environ.get("VIDEO2TEXT_PUBLIC_ORIGIN", "").rstrip("/"),
            shared_secret=os.environ.get("VIDEO2TEXT_SHARED_SECRET", ""),
            proxy_token=os.environ.get("VIDEO2TEXT_PROXY_TOKEN", ""),
            max_upload_bytes=int(os.environ.get("VIDEO2TEXT_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024)),
            max_active_jobs=int(os.environ.get("VIDEO2TEXT_MAX_ACTIVE_JOBS", 4)),
            upload_token_ttl_seconds=int(os.environ.get("VIDEO2TEXT_UPLOAD_TOKEN_TTL_SECONDS", 24 * 60 * 60)),
            media_url_ttl_seconds=int(os.environ.get("VIDEO2TEXT_MEDIA_URL_TTL_SECONDS", 24 * 60 * 60)),
            poll_interval=int(os.environ.get("VIDEO2TEXT_GLADIA_POLL_INTERVAL", 8)),
            poll_max_iters=int(os.environ.get("VIDEO2TEXT_GLADIA_POLL_MAX_ITERS", 900)),
            enabled_translation_providers=_enabled_translation_providers(
                os.environ.get("VIDEO2TEXT_ENABLED_TRANSLATION_PROVIDERS", "minimax")
            ),
        )

    def validate(self) -> None:
        self.enabled_translation_providers = _enabled_translation_providers(
            ",".join(self.enabled_translation_providers)
        )
        if not self.public_origin.startswith("https://"):
            raise RuntimeError("VIDEO2TEXT_PUBLIC_ORIGIN must be an HTTPS origin")
        if len(self.shared_secret) < 32:
            raise RuntimeError("VIDEO2TEXT_SHARED_SECRET must contain at least 32 characters")
        if len(self.proxy_token) < 32:
            raise RuntimeError("VIDEO2TEXT_PROXY_TOKEN must contain at least 32 characters")


def _safe_filename(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value).strip().replace("\\", "/")
    name = normalized.rsplit("/", 1)[-1]
    name = "".join(character for character in name if character >= " " and character not in '<>:"|?*')
    if not name or Path(name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError("unsupported or missing media file extension")
    return name[:180]


def _validated_ticket_request(body: dict[str, Any], settings: WorkerSettings) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    file_name = _safe_filename(str(body.get("file_name") or ""))
    raw_file_size = body.get("file_size")
    if (
        isinstance(raw_file_size, bool)
        or not isinstance(raw_file_size, (int, float))
        or not float(raw_file_size).is_integer()
    ):
        raise ValueError("file_size must be a positive integer")
    file_size = int(raw_file_size)
    if file_size <= 0 or file_size > settings.max_upload_bytes:
        raise ValueError("file size is outside the configured limit")
    content_type = str(body.get("content_type") or "application/octet-stream").strip()
    if not content_type or len(content_type) > 200 or "\r" in content_type or "\n" in content_type:
        raise ValueError("invalid content_type")
    output_format = str(body.get("output_format") or "txt").strip().lower()
    source_language = str(body.get("source_language") or "auto").strip().lower()
    translation_provider = str(body.get("translation_provider") or "minimax").strip().lower()
    translate = body.get("translate", True)
    if output_format not in SUPPORTED_OUTPUT_FORMATS:
        raise ValueError("output_format must be txt or srt")
    if source_language not in SUPPORTED_SOURCE_LANGUAGES:
        raise ValueError("unsupported source language mode")
    if translation_provider not in SUPPORTED_TRANSLATION_PROVIDERS:
        raise ValueError("unsupported translation provider")
    if not isinstance(translate, bool):
        raise ValueError("translate must be a boolean")
    if translate and translation_provider not in settings.enabled_translation_providers:
        raise ValueError(f"translation provider is disabled: {translation_provider}")
    return {
        "file_name": file_name,
        "file_size": file_size,
        "content_type": content_type,
        "output_format": output_format,
        "translate": translate,
        "source_language": source_language,
        "translation_provider": translation_provider,
    }


def _header_from_hook(body: dict[str, Any], name: str) -> str:
    event = body.get("Event") or {}
    http_request = event.get("HTTPRequest") or event.get("HttpRequest") or {}
    headers = http_request.get("Header") or {}
    for key, value in headers.items():
        if key.lower() == name.lower():
            if isinstance(value, list):
                return str(value[0]) if value else ""
            return str(value)
    return request.headers.get(name, "")


def _hook_upload(body: dict[str, Any]) -> dict[str, Any]:
    return (body.get("Event") or {}).get("Upload") or {}


def _reject_hook(message: str, status: int = 401, *, stop: bool = False):
    response: dict[str, Any] = {
        "HTTPResponse": {
            "StatusCode": status,
            "Body": message,
            "Header": {"Content-Type": "text/plain; charset=utf-8"},
        }
    }
    response["StopUpload" if stop else "RejectUpload"] = True
    return jsonify(response), 200


class QueueWorker:
    def __init__(self, settings: WorkerSettings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name="video2text-queue", daemon=True)

    def start(self) -> None:
        self.store.recover_interrupted()
        self.thread.start()

    def run(self) -> None:
        while not self.stop_event.is_set():
            job = self.store.claim_next()
            if job is None:
                self.stop_event.wait(2)
                continue
            self.process(job)

    def process(self, job: dict[str, Any]) -> None:
        job_id = job["job_id"]
        source_path = Path(job["source_path"])
        output_dir = self.settings.data_root / "results" / job_id
        jobs_root = self.settings.data_root / "work" / job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        jobs_root.mkdir(parents=True, exist_ok=True)

        def log(message: str) -> None:
            print(f"[{job_id}] {message}", flush=True)
            self.store.append_log(job_id, message)

        def stage(_source: Path, stage_name: str, detail: str) -> None:
            self.store.update_stage(job_id, stage_name, detail)

        def signed_url(path: Path) -> str:
            return build_signed_media_url(
                path,
                data_root=self.settings.data_root,
                public_origin=self.settings.public_origin,
                secret=self.settings.shared_secret,
                ttl_seconds=self.settings.media_url_ttl_seconds,
            )

        config = PipelineConfig(
            output_format=job["output_format"],
            translate=job["translate"],
            source_language=job["source_language"],
            translation_provider=job["translation_provider"],
            output_dir=output_dir,
            jobs_root=jobs_root,
            poll_interval=self.settings.poll_interval,
            poll_max_iters=self.settings.poll_max_iters,
            gladia_audio_url_factory=signed_url,
            retain_generated_media=True,
        )
        try:
            result = process_one(source_path, config, log=log, stage_callback=stage)
            self.store.complete(
                job_id,
                result_path=result.output_path,
                output_filename=f"{Path(job['file_name']).stem}.{job['output_format']}",
                translated=result.translated,
                media_type=result.media_type,
            )
            try:
                completed_job = self.store.get(job_id) or job
                removed = delete_job_media(completed_job, self.settings.data_root, self.store)
                log(f"[cleanup] removed {removed} completed media path(s); result retained")
            except Exception as cleanup_exc:  # noqa: BLE001
                log(f"[cleanup] deferred completed-media cleanup: {cleanup_exc}")
        except Exception as exc:  # noqa: BLE001
            log(traceback.format_exc())
            self.store.fail(job_id, str(exc))


def _local_readiness(settings: WorkerSettings) -> dict[str, bool]:
    """Local configuration/write checks only, not a paid provider validity probe."""
    checks: dict[str, bool] = {}
    try:
        checks["gladia_configured"] = bool(
            os.environ.get("GLADIA_API_KEY", "").strip() or read_gladia_keys(GLADIA_KEYS_PATH)
        )
    except (OSError, ValueError):
        checks["gladia_configured"] = False
    for provider in settings.enabled_translation_providers:
        try:
            config = read_translation_config(provider)
            checks[f"{provider}_configured"] = all(config.get(key) for key in ("api_key", "base_url", "model"))
        except (OSError, ValueError, TypeError, AttributeError):
            checks[f"{provider}_configured"] = False
    checks["data_writable"] = True
    try:
        for directory in (settings.data_root, *(settings.data_root / name for name in DATA_DIRECTORIES)):
            with tempfile.TemporaryFile(dir=directory) as probe:
                probe.write(b"ready")
                probe.flush()
    except OSError:
        checks["data_writable"] = False
    return checks


def create_app(settings: WorkerSettings | None = None, *, start_worker: bool = True) -> Flask:
    settings = settings or WorkerSettings.from_env()
    settings.validate()
    for directory in DATA_DIRECTORIES:
        (settings.data_root / directory).mkdir(parents=True, exist_ok=True)
    store = JobStore(settings.data_root / "state" / "video2text.sqlite3")
    app = Flask(__name__)
    app.config.update(VIDEO2TEXT_SETTINGS=settings, VIDEO2TEXT_STORE=store)

    if start_worker:
        queue_worker = QueueWorker(settings, store)
        queue_worker.start()
        app.extensions["video2text_queue_worker"] = queue_worker

    def require_proxy_token() -> None:
        supplied = request.headers.get("X-Video2Text-Proxy-Token", "")
        if not hmac.compare_digest(supplied, settings.proxy_token):
            abort(401)

    @app.get("/health")
    def public_health():
        return jsonify({"ok": True, "service": "video2text-nas-worker"})

    @app.get("/api/health")
    def health():
        checks = _local_readiness(settings)
        ready = all(checks.values())
        try:
            usage = shutil.disk_usage(settings.data_root)
            disk_used_percent = round(usage.used / usage.total * 100, 1)
        except OSError:
            disk_used_percent = None
        return jsonify(
            {
                "ok": True,
                "service": "video2text-nas-worker",
                "ready": ready,
                "checks": checks,
                "active_jobs": store.active_count(),
                "disk_used_percent": disk_used_percent,
            }
        ), 200 if ready else 503

    @app.get("/api/capabilities")
    def capabilities():
        return jsonify(
            {
                "ok": True,
                "ready": all(_local_readiness(settings).values()),
                "backend": "docker-nas",
                "upload": {"protocol": "tus", "max_bytes": settings.max_upload_bytes},
                "outputs": sorted(SUPPORTED_OUTPUT_FORMATS),
                "source_languages": sorted(SUPPORTED_SOURCE_LANGUAGES),
                "translation_providers": list(settings.enabled_translation_providers),
                "worker_concurrency": 1,
            }
        )

    @app.post("/api/nas-ticket")
    def nas_ticket():
        try:
            validated = _validated_ticket_request(request.get_json(silent=True) or {}, settings)
            now = int(time.time())
            payload = {
                "version": 1,
                "job_id": f"nas_{secrets.token_hex(6)}",
                **validated,
                "expires_at": now + settings.upload_token_ttl_seconds,
                "nonce": secrets.token_hex(12),
            }
            return jsonify(
                {
                    "ok": True,
                    "backend": "nas",
                    "job_id": payload["job_id"],
                    "job_url": f"/jobs/{payload['job_id']}",
                    "upload_endpoint": f"{settings.public_origin}/files/",
                    "upload_token": encode_upload_token(payload, settings.shared_secret),
                    "expires_at": payload["expires_at"],
                }
            )
        except (TokenError, ValueError, TypeError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

    @app.post("/hooks/tusd")
    def tusd_hook():
        body = request.get_json(silent=True) or {}
        hook_type = str(body.get("Type") or "")
        token = _header_from_hook(body, "X-Upload-Token")
        try:
            ticket = decode_upload_token(
                token,
                settings.shared_secret,
                require_not_expired=hook_type != "post-finish",
            )
            if not JOB_ID_PATTERN.fullmatch(str(ticket.get("job_id") or "")):
                raise TokenError("invalid NAS job id")
            file_name = _safe_filename(str(ticket.get("file_name") or ""))
            file_size = int(ticket.get("file_size") or 0)
            if file_size <= 0 or file_size > settings.max_upload_bytes:
                raise TokenError("file size is outside the configured limit")
        except (TokenError, ValueError, TypeError) as exc:
            if hook_type == "post-finish":
                return jsonify({"error": str(exc)}), 500
            return _reject_hook(str(exc), stop=hook_type != "pre-create")

        upload = _hook_upload(body)
        upload_size = int(upload.get("Size") or 0)
        if upload_size and upload_size != file_size:
            if hook_type == "post-finish":
                return jsonify({"error": "upload size does not match its signed ticket"}), 500
            return _reject_hook("upload size does not match its signed ticket", status=400, stop=hook_type != "pre-create")

        if hook_type == "pre-create":
            try:
                store.register_upload(ticket, settings.max_active_jobs)
            except ValueError as exc:
                return _reject_hook(str(exc), status=409)
            return jsonify({})

        if hook_type == "post-receive":
            upload_id = str(upload.get("ID") or "")
            if upload_id and Path(upload_id).name == upload_id:
                store.touch_upload(ticket["job_id"], upload_id)
            return jsonify({})

        if hook_type == "post-finish":
            upload_id = str(upload.get("ID") or "")
            if not upload_id or Path(upload_id).name != upload_id:
                return jsonify({"error": "invalid tus upload id"}), 500
            source = settings.data_root / "uploads" / upload_id
            target_dir = settings.data_root / "media" / ticket["job_id"]
            target = target_dir / file_name
            target_dir.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                if not source.is_file():
                    return jsonify({"error": "completed upload file is missing"}), 500
                source.replace(target)
            (settings.data_root / "uploads" / f"{upload_id}.info").unlink(missing_ok=True)
            store.enqueue(ticket["job_id"], upload_id, target)
            return jsonify({})

        return jsonify({})

    @app.get("/api/jobs-status")
    def browser_job_status():
        job_id = str(request.args.get("job_id") or "").strip()
        if not JOB_ID_PATTERN.fullmatch(job_id):
            return jsonify({"ok": False, "error": "invalid NAS job id"}), 400
        payload = store.public_status(job_id)
        if payload is None:
            return jsonify({"ok": False, "error": "job not found"}), 404
        return jsonify(payload)

    @app.get("/api/jobs-result")
    def browser_job_result():
        job_id = str(request.args.get("job_id") or "").strip()
        if not JOB_ID_PATTERN.fullmatch(job_id):
            return jsonify({"ok": False, "error": "invalid NAS job id"}), 400
        payload = store.public_result(job_id)
        if payload is None:
            return jsonify({"ok": False, "error": "result not ready"}), 404
        return jsonify(payload)

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str):
        require_proxy_token()
        payload = store.public_status(job_id)
        if payload is None:
            return jsonify({"ok": False, "error": "job not found"}), 404
        return jsonify(payload)

    @app.get("/api/jobs/<job_id>/result")
    def job_result(job_id: str):
        require_proxy_token()
        payload = store.public_result(job_id)
        if payload is None:
            return jsonify({"ok": False, "error": "result not ready"}), 404
        return jsonify(payload)

    @app.route("/media/<path:relative_path>", methods=["GET", "HEAD"])
    def media(relative_path: str):
        try:
            expires_at = int(request.args.get("expires") or 0)
        except ValueError:
            abort(403)
        signature = request.args.get("signature") or ""
        if not verify_media_signature(relative_path, expires_at, signature, settings.shared_secret):
            abort(403)
        root = settings.data_root.resolve()
        path = (root / relative_path).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            abort(403)
        if not path.is_file():
            abort(404)
        return send_file(path, conditional=True, etag=True, download_name=path.name)

    return app
