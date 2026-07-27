from __future__ import annotations

import importlib.util
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

_CORE_PATH = Path(__file__).resolve().parent / "web_core.py"
_CORE_SPEC = importlib.util.spec_from_file_location("_web_core", _CORE_PATH)
_CORE = importlib.util.module_from_spec(_CORE_SPEC)
assert _CORE_SPEC is not None and _CORE_SPEC.loader is not None
_CORE_SPEC.loader.exec_module(_CORE)
AUDIO_EXTS = _CORE.AUDIO_EXTS
SUPPORTED_EXTS = _CORE.SUPPORTED_EXTS
VIDEO_EXTS = _CORE.VIDEO_EXTS


GLADIA_BASE = "https://api.gladia.io/v2"
GLADIA_UPLOAD_URL = f"{GLADIA_BASE}/upload"
GLADIA_TRANSCRIBE_URL = f"{GLADIA_BASE}/pre-recorded"
DEEPL_URL = "https://api-free.deepl.com/v2/translate"
POLL_INTERVAL_SECONDS = 5
POLL_MAX_ITERS = 11
DEEPL_BATCH_SIZE = 40
DEEPL_MAX_CHARS = 45000


def load_gladia_key() -> str:
    key = os.environ.get("GLADIA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GLADIA_API_KEY is not configured on the web runtime")
    return key


def load_deepl_key() -> str:
    key = os.environ.get("DEEPL_KEY", "").strip()
    if not key:
        raise RuntimeError("DEEPL_KEY is not configured on the web runtime")
    return key


def _read_json_response(response) -> dict:
    raw = response.read()
    return json.loads(raw.decode("utf-8") or "{}")


def _http_error_message(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        body = ""
    return f"HTTP {exc.code}: {body[:500]}"


def upload_media_bytes(filename: str, content: bytes, content_type: str | None = None) -> str:
    boundary = "----video2text-gladia-upload"
    mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        content,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    body = b"".join(parts)
    headers = {
        "x-gladia-key": load_gladia_key(),
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    request = urllib.request.Request(GLADIA_UPLOAD_URL, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = _read_json_response(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Gladia upload failed: {_http_error_message(exc)}") from exc
    audio_url = payload.get("audio_url")
    if not audio_url:
        raise RuntimeError(f"Gladia upload returned no audio_url: {payload}")
    return str(audio_url)


def download_media_bytes(source_url: str) -> tuple[str, bytes, str | None]:
    request = urllib.request.Request(source_url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            content = response.read()
            content_type = response.headers.get_content_type() if response.headers else None
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media download failed: {_http_error_message(exc)}") from exc

    parsed = urlparse(source_url)
    filename = Path(parsed.path).name or "media"
    return filename, content, content_type


def _build_transcribe_payload(media_url: str) -> dict[str, object]:
    return {
        "audio_url": media_url,
        "language_config": {"languages": ["en"], "code_switching": False},
        "diarization": True,
        "diarization_config": {"min_speakers": 1, "max_speakers": 4},
        "sentences": True,
        "subtitles": True,
        "subtitles_config": {
            "formats": ["srt"],
            "maximum_characters_per_row": 42,
            "maximum_rows_per_caption": 2,
            "style": "compliance",
        },
        "summarization": False,
        "chapterization": False,
        "sentiment_analysis": False,
    }


def submit_transcription(media_url: str) -> str:
    headers = {
        "x-gladia-key": load_gladia_key(),
        "Content-Type": "application/json",
    }
    body = json.dumps(_build_transcribe_payload(media_url)).encode("utf-8")
    request = urllib.request.Request(GLADIA_TRANSCRIBE_URL, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = _read_json_response(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Gladia transcription submit failed: {_http_error_message(exc)}") from exc
    job_id = payload.get("id")
    if not job_id:
        raise RuntimeError(f"Gladia transcription submit returned no job id: {payload}")
    return str(job_id)


def wait_for_transcription(job_id: str) -> dict:
    headers = {"x-gladia-key": load_gladia_key()}
    request = urllib.request.Request(f"{GLADIA_TRANSCRIBE_URL}/{job_id}", method="GET", headers=headers)
    for _ in range(POLL_MAX_ITERS):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = _read_json_response(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Gladia polling failed: {_http_error_message(exc)}") from exc
        status = payload.get("status")
        if status == "done":
            return payload.get("result") or {}
        if status == "error":
            raise RuntimeError(f"Gladia transcription job failed: {payload}")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise TimeoutError("Cloud processing timed out before transcription completed")


def extract_segments(result: dict) -> list[dict[str, object]]:
    utterances = result.get("transcription", {}).get("utterances", [])
    segments: list[dict[str, object]] = []
    for item in utterances:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        segments.append(
            {
                "start": round(float(item.get("start", 0.0)), 2),
                "end": round(float(item.get("end", 0.0)), 2),
                "speaker": item.get("speaker"),
                "text": text,
                "confidence": item.get("confidence"),
            }
        )
    return segments


def _deepl_translate_batch(texts: list[str]) -> list[str]:
    if not texts:
        return []
    from urllib.parse import quote

    form_parts = [f"text={quote(text, safe='')}" for text in texts]
    form_parts.append("source_lang=EN")
    form_parts.append("target_lang=ZH")
    body = "&".join(form_parts).encode("utf-8")
    headers = {
        "Authorization": f"DeepL-Auth-Key {load_deepl_key()}",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    request = urllib.request.Request(DEEPL_URL, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = _read_json_response(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"DeepL translation failed: {_http_error_message(exc)}") from exc
    translations = payload.get("translations", [])
    if len(translations) != len(texts):
        raise RuntimeError(f"DeepL returned {len(translations)} results for {len(texts)} inputs")
    return [str(item.get("text", "")).strip() for item in translations]


def translate_segments(segments: list[dict[str, object]]) -> list[dict[str, object]]:
    pending: list[str] = []
    translated_texts: list[str] = []
    pending_chars = 0

    def flush_batch() -> None:
        nonlocal pending, translated_texts, pending_chars
        translated_texts.extend(_deepl_translate_batch(pending))
        pending = []
        pending_chars = 0

    for segment in segments:
        text = str(segment.get("text", ""))
        if pending and (len(pending) >= DEEPL_BATCH_SIZE or pending_chars + len(text) > DEEPL_MAX_CHARS):
            flush_batch()
        pending.append(text)
        pending_chars += len(text)
    if pending:
        flush_batch()

    result: list[dict[str, object]] = []
    for segment, zh_text in zip(segments, translated_texts):
        result.append(
            {
                "start": segment["start"],
                "end": segment["end"],
                "speaker": segment.get("speaker"),
                "text": zh_text,
            }
        )
    return result


def format_timestamp(value: float) -> str:
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    seconds = value % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}".replace(".", ",")


def render_txt(segments_en: list[dict[str, object]], segments_zh: list[dict[str, object]] | None = None) -> str:
    lines: list[str] = []
    if segments_zh is None:
        lines.extend(str(segment["text"]).strip() for segment in segments_en)
        return "\n".join(lines).strip() + "\n"
    for zh_segment, en_segment in zip(segments_zh, segments_en):
        zh = str(zh_segment["text"]).strip()
        en = str(en_segment["text"]).strip()
        if zh:
            lines.append(zh)
        if en:
            lines.append(en)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_srt(segments_en: list[dict[str, object]], segments_zh: list[dict[str, object]] | None = None) -> str:
    lines: list[str] = []
    for index, en_segment in enumerate(segments_en, 1):
        lines.append(str(index))
        lines.append(f"{format_timestamp(float(en_segment['start']))} --> {format_timestamp(float(en_segment['end']))}")
        if segments_zh is None:
            lines.append(str(en_segment["text"]).strip())
        else:
            zh = str(segments_zh[index - 1]["text"]).strip()
            en = str(en_segment["text"]).strip()
            if zh:
                lines.append(zh)
            if en:
                lines.append(en)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def resolve_source_name(input_mode: str, file_name: str | None, source_url: str | None) -> str:
    if input_mode == "upload" and file_name:
        return file_name
    if source_url:
        parsed = urlparse(source_url)
        name = Path(parsed.path).name
        if name:
            return name
    return "media"


def build_output_filename(source_name: str, output_format: str) -> str:
    stem = Path(source_name).stem or "media"
    return f"{stem}.{output_format}"


def process_media(
    *,
    input_mode: str,
    output_format: str,
    translate: bool,
    file_name: str | None = None,
    file_bytes: bytes | None = None,
    file_content_type: str | None = None,
    source_url: str | None = None,
) -> dict[str, object]:
    source_name = resolve_source_name(input_mode, file_name, source_url)
    source_ext = Path(source_name).suffix.lower()
    if source_ext and source_ext not in SUPPORTED_EXTS:
        raise ValueError(f"unsupported media type: {source_ext}")

    if input_mode == "upload":
        if file_bytes is None or file_name is None:
            raise ValueError("uploaded file content is missing")
        media_url = upload_media_bytes(file_name, file_bytes, file_content_type)
    else:
        if not source_url:
            raise ValueError("source_url is required")
        downloaded_name, downloaded_bytes, downloaded_type = download_media_bytes(source_url)
        media_url = upload_media_bytes(downloaded_name, downloaded_bytes, downloaded_type)

    result = wait_for_transcription(submit_transcription(media_url))
    segments_en = extract_segments(result)
    if not segments_en:
        raise RuntimeError("No transcript segments were returned")

    media_type = "video" if source_ext in VIDEO_EXTS else "audio"
    segments_zh = translate_segments(segments_en) if translate else None
    output_text = render_txt(segments_en, segments_zh) if output_format == "txt" else render_srt(segments_en, segments_zh)
    output_filename = build_output_filename(source_name, output_format)

    return {
        "media_type": media_type,
        "source_name": source_name,
        "output_filename": output_filename,
        "output_text": output_text,
        "segment_count": len(segments_en),
        "translated": translate and segments_zh is not None,
    }
