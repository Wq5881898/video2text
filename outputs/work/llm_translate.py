#!/usr/bin/env python3
"""Streaming English-to-Chinese subtitle translation for supported LLM providers."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


RUNTIME_ROOT = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parents[2]
)
CONFIG_DIR = Path(os.environ.get("VIDEO2TEXT_CONFIG_DIR", RUNTIME_ROOT / "config")).resolve()
BATCH_SIZE = 40
MAX_CHARS_PER_BATCH = 12_000
MAX_RETRIES = 2
REQUEST_TIMEOUT = 180
PROMPT_VERSION = "subtitle-json-v2-stream"

PROVIDERS = {
    "minimax": {
        "label": "MiniMax M3",
        "config_file": "minimax.json",
        "env_prefix": "MINIMAX",
        "base_url": "https://api.minimaxi.com/v1",
        "model": "MiniMax-M3",
    },
    "glm": {
        "label": "GLM",
        "config_file": "glm.json",
        "env_prefix": "GLM",
        "base_url": "https://api.z.ai/api/coding/paas/v4",
        "model": "glm-5.3-flash",
    },
    "qwen": {
        "label": "Qwen",
        "config_file": "qwen.json",
        "env_prefix": "QWEN",
        "base_url": "",
        "model": "",
    },
}

SYSTEM_PROMPT = (
    "Translate every English subtitle segment into natural Simplified Chinese. "
    "Preserve meaning, names, numbers, tone, and every id. Never merge, split, omit, "
    "renumber, or add segments. Do not explain your reasoning. Return only valid compact "
    "JSON exactly shaped as "
    '{"translations":[{"id":1,"text":"Chinese translation"}]}.'
)


class PermanentTranslationError(RuntimeError):
    """An authentication, quota, model, or request error that splitting cannot fix."""


def normalize_provider(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized not in PROVIDERS:
        raise ValueError(f"Unsupported translation provider: {provider}")
    return normalized


def load_config(provider: str) -> dict[str, str]:
    normalized = normalize_provider(provider)
    spec = PROVIDERS[normalized]
    path = CONFIG_DIR / str(spec["config_file"])
    payload = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    env_prefix = str(spec["env_prefix"])
    config = {
        "provider": normalized,
        "label": str(spec["label"]),
        "config_path": str(path),
        "base_url": os.environ.get(f"{env_prefix}_BASE_URL", "").strip()
        or str(payload.get("base_url") or spec["base_url"]).strip(),
        "api_key": os.environ.get(f"{env_prefix}_API_KEY", "").strip()
        or str(payload.get("api_key") or "").strip(),
        "model": os.environ.get(f"{env_prefix}_MODEL", "").strip()
        or str(payload.get("model") or spec["model"]).strip(),
    }
    missing = [name for name in ("base_url", "api_key", "model") if not config[name]]
    if missing:
        raise FileNotFoundError(
            f"{config['label']} configuration is missing {', '.join(missing)} in {path}"
        )
    return config


def _request_payload(config: dict[str, str], segments: list[dict]) -> dict:
    payload: dict = {
        "model": config["model"],
        "temperature": 0,
        "max_tokens": 4000,
        "stream": True,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"segments": segments}, ensure_ascii=False)},
        ],
    }
    if config["provider"] == "minimax":
        payload.update({"reasoning_split": True, "thinking": {"type": "disabled"}})
    elif config["provider"] == "glm":
        payload["thinking"] = {"type": "disabled"}
    return payload


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for item in content:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                pieces.append(item["text"])
        return "".join(pieces)
    return ""


def _error_detail(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace").strip()
    try:
        payload = json.loads(text)
        error = payload.get("error") or payload
        if isinstance(error, dict):
            return str(error.get("message") or error.get("detail") or "").strip()
    except json.JSONDecodeError:
        pass
    return text[:300]


def _stream_completion(config: dict[str, str], segments: list[dict]) -> tuple[str, str | None]:
    request = urllib.request.Request(
        f"{config['base_url'].rstrip('/')}/chat/completions",
        data=json.dumps(_request_payload(config, segments), ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
        },
        method="POST",
    )
    pieces: list[str] = []
    finish_reason: str | None = None
    saw_sse = False
    plain_response: list[str] = []
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    plain_response.append(line)
                    continue
                saw_sse = True
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise RuntimeError(str(chunk["error"]))
                choice = (chunk.get("choices") or [{}])[0]
                pieces.append(_content_text((choice.get("delta") or {}).get("content")))
                if choice.get("finish_reason") is not None:
                    finish_reason = str(choice["finish_reason"])
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc.read())
        message = f"{config['label']} HTTP {exc.code}" + (f": {detail}" if detail else "")
        if exc.code in {400, 401, 402, 403, 404, 409, 422, 429}:
            raise PermanentTranslationError(message) from exc
        raise RuntimeError(message) from exc

    if not saw_sse:
        payload = json.loads("".join(plain_response))
        choice = (payload.get("choices") or [{}])[0]
        pieces.append(_content_text((choice.get("message") or {}).get("content")))
        if choice.get("finish_reason") is not None:
            finish_reason = str(choice["finish_reason"])
    return "".join(pieces).strip(), finish_reason


def _parse_translations(content: str) -> list[dict]:
    clean = content.strip()
    if clean.startswith("```"):
        clean = clean.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        payload = json.loads(clean)
    except json.JSONDecodeError:
        start = clean.find("{")
        if start < 0:
            raise
        payload, _end = json.JSONDecoder().raw_decode(clean[start:])
    translated = payload.get("translations") if isinstance(payload, dict) else None
    if not isinstance(translated, list):
        raise ValueError("response has no translations array")
    return translated


def _request(config: dict[str, str], segments: list[dict]) -> list[dict]:
    started = time.perf_counter()
    content, finish_reason = _stream_completion(config, segments)
    elapsed = time.perf_counter() - started
    print(
        f"  [{config['provider']}] stream complete: {len(content)} chars in {elapsed:.1f}s",
        flush=True,
    )
    if finish_reason not in {None, "stop"}:
        raise RuntimeError(f"output incomplete: finish_reason={finish_reason}")
    if not content:
        raise RuntimeError("stream ended without content")
    return _parse_translations(content)


def _validated_request(config: dict[str, str], segments: list[dict]) -> list[str]:
    expected_ids = [int(item["id"]) for item in segments]
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            translated = _request(config, segments)
            received_ids = [int(item.get("id")) for item in translated]
            texts = [str(item.get("text") or "").strip() for item in translated]
            if received_ids != expected_ids:
                raise ValueError(f"IDs differ: expected {expected_ids}, received {received_ids}")
            if any(not text for text in texts):
                raise ValueError("provider returned an empty translation")
            return texts
        except PermanentTranslationError:
            raise
        except (OSError, urllib.error.URLError, json.JSONDecodeError, KeyError, TypeError, ValueError, RuntimeError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                print(
                    f"  [{config['provider']}] retry {attempt}/{MAX_RETRIES}: {exc}",
                    flush=True,
                )
                time.sleep(2)
    raise RuntimeError(
        f"{config['label']} batch failed after {MAX_RETRIES} attempts: {last_error}"
    )


def _translate_resilient(config: dict[str, str], segments: list[dict]) -> list[str]:
    try:
        return _validated_request(config, segments)
    except PermanentTranslationError:
        raise
    except RuntimeError:
        if len(segments) == 1:
            raise
        middle = len(segments) // 2
        print(
            f"  [{config['provider']}] splitting failed batch: "
            f"{len(segments)} -> {middle}+{len(segments) - middle}",
            flush=True,
        )
        return _translate_resilient(config, segments[:middle]) + _translate_resilient(
            config, segments[middle:]
        )


def _make_batches(segments: list[dict]) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for segment in segments:
        length = len(str(segment.get("text") or ""))
        if current and (
            len(current) >= BATCH_SIZE or current_chars + length > MAX_CHARS_PER_BATCH
        ):
            batches.append(current)
            current = []
            current_chars = 0
        current.append(segment)
        current_chars += length
    if current:
        batches.append(current)
    return batches


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def translate_segments(en_segments: list[dict], out_path: Path, provider: str = "minimax") -> list[dict]:
    config = load_config(provider)
    cached: dict[tuple[object, object, str], dict] = {}
    if out_path.exists():
        try:
            previous = json.loads(out_path.read_text(encoding="utf-8"))
            cache_matches = (
                previous.get("_translator") == config["provider"]
                and previous.get("_translation_model") == config["model"]
                and previous.get("_translation_prompt_version", PROMPT_VERSION) == PROMPT_VERSION
            )
            if cache_matches:
                for item in previous.get("segments_zh", []):
                    source_text = str(item.get("source_text") or "")
                    if source_text and item.get("text"):
                        cached[(item.get("start"), item.get("end"), source_text)] = item
        except (OSError, json.JSONDecodeError):
            pass

    output: list[dict | None] = [None] * len(en_segments)
    pending: list[tuple[int, dict]] = []
    for index, segment in enumerate(en_segments):
        cache_key = (segment.get("start"), segment.get("end"), str(segment.get("text") or ""))
        if cache_key in cached:
            output[index] = cached[cache_key]
        else:
            pending.append((index, segment))
    print(
        f"[{config['provider']}] model={config['model']}; streaming enabled; "
        f"cache hit {len(en_segments) - len(pending)}/{len(en_segments)}",
        flush=True,
    )

    request_segments = [
        {"id": index, "text": str(segment.get("text") or "")} for index, segment in pending
    ]
    batches = _make_batches(request_segments)
    pending_by_index = dict(pending)
    for batch_index, batch in enumerate(batches, 1):
        print(
            f"  [{config['provider']}] batch {batch_index}/{len(batches)} "
            f"({len(batch)} segments)",
            flush=True,
        )
        texts = _translate_resilient(config, batch)
        for request_item, translated_text in zip(batch, texts):
            index = int(request_item["id"])
            source = pending_by_index[index]
            output[index] = {
                "start": source["start"],
                "end": source["end"],
                "speaker": source.get("speaker"),
                "text": translated_text,
                "source_text": source.get("text", ""),
            }
        completed = [item for item in output if item is not None]
        _atomic_json(
            out_path,
            {
                "duration": None,
                "language": "en",
                "segments_en": en_segments,
                "segments_zh": completed,
                "_fetch_ts": time.time(),
                "_translator": config["provider"],
                "_translation_model": config["model"],
                "_translation_prompt_version": PROMPT_VERSION,
                "_translation_streaming": True,
                "_translation_complete": len(completed) == len(en_segments),
            },
        )

    if any(item is None for item in output):
        raise RuntimeError(f"{config['label']} translation ended with missing segments")
    return [item for item in output if item is not None]


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in {2, 3}:
        raise SystemExit(
            "usage: llm_translate.py <utt_clean.json> <gladia_zh.json> "
            "[minimax|glm|qwen]"
        )
    input_path, output_path = map(Path, args[:2])
    provider = args[2] if len(args) == 3 else "minimax"
    en_segments = json.loads(input_path.read_text(encoding="utf-8-sig"))
    zh_segments = translate_segments(en_segments, output_path, provider)
    print(
        f"[{normalize_provider(provider)}] wrote {len(en_segments)} en + "
        f"{len(zh_segments)} zh to {output_path.name}",
        flush=True,
    )


if __name__ == "__main__":
    main()
