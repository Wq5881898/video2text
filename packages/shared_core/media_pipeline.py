from __future__ import annotations

import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .audio_chunks import (
    MAX_AUDIO_SECONDS,
    chunk_extension,
    merge_part_transcripts,
    plan_audio_parts,
    prepare_audio_part,
    probe_audio,
    write_json_atomic,
)

from .key_management import (
    CONFIG_ROOT,
    GLADIA_KEYS_PATH,
    application_root,
    normalize_translation_provider,
    read_translation_config,
    read_translation_key,
    translation_config_path,
    translation_provider_label,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
def runtime_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return REPO_ROOT


RUNTIME_ROOT = runtime_root()
RESOURCE_WORK_ROOT = (
    application_root() if getattr(sys, "frozen", False) else RUNTIME_ROOT
) / "outputs" / "work"
if str(RESOURCE_WORK_ROOT) not in sys.path:
    sys.path.insert(0, str(RESOURCE_WORK_ROOT))

import gladia as g
import llm_translate
import run_zh_pipeline as rzp


LogFn = Callable[[str], None]
StageFn = Callable[[Path, str, str], None]
AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v"}
SUPPORTED_EXTS = AUDIO_EXTS | VIDEO_EXTS
FFMPEG_FALLBACK = Path(r"D:\program\ffmpeg\bin\ffmpeg.exe")
FFPROBE_FALLBACK = Path(r"D:\program\ffmpeg\bin\ffprobe.exe")
DEFAULT_JOBS_ROOT = application_root() / "outputs" / "work" / "jobs"
def bundled_binary(name: str) -> Path | None:
    candidate = runtime_root() / "bin" / f"{name}.exe"
    return candidate if candidate.exists() else None


@dataclass(slots=True)
class PipelineConfig:
    output_format: str
    translate: bool
    source_language: str = "auto"
    translation_provider: str = "minimax"
    output_dir: Path | None = None
    jobs_root: Path = DEFAULT_JOBS_ROOT
    poll_interval: int = 8
    poll_max_iters: int = 90
    max_audio_seconds: float = MAX_AUDIO_SECONDS


@dataclass(slots=True)
class PipelineResult:
    source_path: Path
    media_type: str
    prepared_audio_path: Path
    output_path: Path
    job_dir: Path
    translated: bool
    output_format: str


@dataclass(slots=True)
class EnvironmentCheck:
    name: str
    ok: bool
    detail: str


class GladiaJobFailedError(RuntimeError):
    """A terminal remote failure, unlike a retryable polling timeout."""


def default_log(message: str) -> None:
    print(message, flush=True)


def default_stage_callback(_source_path: Path, _stage: str, _detail: str) -> None:
    return


def _has_nonempty_file(path: Path) -> bool:
    return path.exists() and bool(path.read_text(encoding="utf-8").strip())


def collect_environment_checks(
    *,
    needs_translation: bool,
    needs_video_tools: bool,
    translation_provider: str = "minimax",
) -> list[EnvironmentCheck]:
    checks: list[EnvironmentCheck] = []

    try:
        ffmpeg_path = find_binary("ffmpeg", FFMPEG_FALLBACK) if needs_video_tools else ""
        ffprobe_path = find_binary("ffprobe", FFPROBE_FALLBACK) if needs_video_tools else ""
        if needs_video_tools:
            checks.append(EnvironmentCheck("ffmpeg", True, ffmpeg_path))
            checks.append(EnvironmentCheck("ffprobe", True, ffprobe_path))
        else:
            checks.append(EnvironmentCheck("ffmpeg", True, "Not needed for current queue"))
            checks.append(EnvironmentCheck("ffprobe", True, "Not needed for current queue"))
    except FileNotFoundError as exc:
        missing_name = "ffprobe" if "ffprobe" in str(exc).lower() else "ffmpeg"
        checks.append(EnvironmentCheck(missing_name, False, str(exc)))
        if missing_name == "ffmpeg":
            checks.append(EnvironmentCheck("ffprobe", False, "Blocked because ffmpeg/ffprobe path is incomplete"))

    gladia_env = bool(os.environ.get("GLADIA_API_KEY", "").strip())
    gladia_file = _has_nonempty_file(GLADIA_KEYS_PATH)
    checks.append(
        EnvironmentCheck(
            "gladia",
            gladia_env or gladia_file,
            "GLADIA_API_KEY env" if gladia_env else (str(GLADIA_KEYS_PATH) if gladia_file else f"Missing {GLADIA_KEYS_PATH}"),
        )
    )

    provider = normalize_translation_provider(translation_provider)
    provider_label = translation_provider_label(provider)
    provider_key_present = bool(read_translation_key(provider))
    provider_path = translation_config_path(provider)
    provider_config = read_translation_config(provider)
    provider_ready = provider_key_present and bool(
        provider_config.get("base_url") and provider_config.get("model")
    )
    if needs_translation:
        checks.append(
            EnvironmentCheck(
                provider,
                provider_ready,
                str(provider_path) if provider_ready else f"Missing or incomplete {provider_path}",
            )
        )
    else:
        checks.append(EnvironmentCheck(provider, True, f"{provider_label} not needed when translation is off"))

    return checks


def find_binary(name: str, fallback: Path) -> str:
    bundled = bundled_binary(name)
    if bundled is not None:
        return str(bundled)
    found = shutil.which(name)
    if found:
        return found
    if fallback.exists():
        return str(fallback)
    raise FileNotFoundError(f"{name} not found in PATH and fallback missing: {fallback}")


def classify_input(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in VIDEO_EXTS:
        return "video"
    raise ValueError(f"unsupported media type: {path}")


def stable_job_tag(src: Path) -> str:
    digest = hashlib.md5(str(src.resolve()).encode("utf-8")).hexdigest()[:8]
    return f"{src.stem}__{digest}"


def probe_channels(ffprobe_exe: str, src: Path) -> int:
    result = subprocess.run(
        [
            ffprobe_exe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=channels",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(src),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError(f"ffprobe could not read channel count: {src}")
    return int(value)


def extract_audio_for_video(src: Path, out_audio: Path, log: LogFn = default_log) -> None:
    ffmpeg_exe = find_binary("ffmpeg", FFMPEG_FALLBACK)
    ffprobe_exe = find_binary("ffprobe", FFPROBE_FALLBACK)
    channels = probe_channels(ffprobe_exe, src)
    log(f"[extract] {src.name}: channels={channels}")
    temp_audio = out_audio.with_name(f".{out_audio.stem}.extracting{out_audio.suffix}")
    temp_audio.unlink(missing_ok=True)
    if channels == 1:
        cmd = [
            ffmpeg_exe,
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            str(temp_audio),
        ]
        log("[extract] mode=copy mono audio stream")
    else:
        cmd = [
            ffmpeg_exe,
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-map",
            "0:a:0",
            "-af",
            "pan=mono|c0=FL",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(temp_audio),
        ]
        log("[extract] mode=left-channel to mono AAC")
    try:
        subprocess.run(cmd, check=True)
        temp_audio.replace(out_audio)
    finally:
        temp_audio.unlink(missing_ok=True)


def wait_for_gladia_result(
    key: str,
    job_id: str,
    *,
    poll_interval: int = 8,
    max_iters: int = 90,
) -> dict:
    url = f"{g.BASE}/pre-recorded/{job_id}"
    for _ in range(max_iters):
        req = urllib.request.Request(url, headers={"x-gladia-key": key})
        raw = urllib.request.urlopen(req, timeout=30).read()
        payload = json.loads(raw)
        status = payload.get("status")
        if status == "done":
            return payload["result"]
        if status == "error":
            raise GladiaJobFailedError(f"Gladia job failed: {payload}")
        time.sleep(poll_interval)
    raise TimeoutError(f"Gladia polling timeout for job {job_id}")


def language_config_for_mode(source_language: str) -> tuple[list[str], bool]:
    modes = {
        "auto": ([], False),
        "en": (["en"], False),
        "zh": (["zh"], False),
        "en_zh": (["en", "zh"], True),
    }
    if source_language not in modes:
        raise ValueError(f"unsupported source language mode: {source_language}")
    return modes[source_language]


def write_raw_result(result: dict, job_id: str, raw_path: Path, zh_path: Path) -> tuple[list[dict], list[str]]:
    transcription = result.get("transcription", {})
    segments = [
        {
            "start": round(u["start"], 2),
            "end": round(u["end"], 2),
            "speaker": u.get("speaker"),
            "text": u["text"].strip(),
            "confidence": u.get("confidence"),
            "language": u.get("language"),
        }
        for u in transcription.get("utterances", [])
    ]
    detected_languages = list(dict.fromkeys(
        language
        for language in (
            list(transcription.get("languages") or [])
            + [segment.get("language") for segment in segments]
        )
        if language
    ))
    primary_language = detected_languages[0] if detected_languages else "unknown"
    raw_data = {
        "duration": result.get("metadata", {}).get("audio_duration"),
        "language": primary_language,
        "languages": detected_languages,
        "segments": segments,
        "job_id": job_id,
        "_fetch_ts": time.time(),
    }
    write_json_atomic(raw_path, raw_data)
    zh_data = {
        "duration": result.get("metadata", {}).get("audio_duration"),
        "language": primary_language,
        "languages": detected_languages,
        "segments_en": segments,
        "segments_zh": [],
        "job_id": job_id,
        "_fetch_ts": time.time(),
        "_fetch_stage": "source-transcript",
    }
    write_json_atomic(zh_path, zh_data)
    return segments, detected_languages


def run_dedup(raw_path: Path, out_path: Path) -> list[dict]:
    dedup_script = RESOURCE_WORK_ROOT / "dedup.py"
    if not dedup_script.is_file():
        raise FileNotFoundError(f"Dedup script not found: {dedup_script}")
    old_argv = sys.argv[:]
    try:
        sys.argv = [str(dedup_script), str(raw_path), str(out_path)]
        runpy.run_path(str(dedup_script), run_name="__main__")
    finally:
        sys.argv = old_argv
    return json.loads(out_path.read_text(encoding="utf-8"))


def render_txt_en(segments: list[dict], out_path: Path) -> None:
    out_path.write_text("\n".join(seg["text"].strip() for seg in segments if seg.get("text")), encoding="utf-8")


def render_txt_bilingual(en_segments: list[dict], zh_segments: list[dict], out_path: Path) -> None:
    paired = align_bilingual_segments(en_segments, zh_segments)
    lines = []
    for en_segment, zh_segment in paired:
        zh = rzp.clean_zh(zh_segment["text"].strip())
        en = en_segment["text"].strip()
        if zh:
            lines.append(zh)
        if en:
            lines.append(en)
        lines.append("")
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def align_bilingual_segments(en_segments: list[dict], zh_segments: list[dict]) -> list[tuple[dict, dict]]:
    if len(en_segments) != len(zh_segments):
        raise ValueError(f"Bilingual segment count mismatch: en={len(en_segments)} zh={len(zh_segments)}")
    paired = []
    for index, (en, zh) in enumerate(zip(en_segments, zh_segments), 1):
        if (en.get("start"), en.get("end")) != (zh.get("start"), zh.get("end")):
            raise ValueError(f"Bilingual timestamps differ at segment {index}")
        if zh.get("source_text") is not None and zh["source_text"] != en.get("text"):
            raise ValueError(f"Bilingual source text differs at segment {index}")
        if not str(zh.get("text") or "").strip():
            raise ValueError(f"Empty Chinese translation at segment {index}")
        paired.append((en, zh))
    return paired


def fmt_srt_timestamp(value: float) -> str:
    milliseconds = max(0, round(value * 1000))
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def render_srt_en(segments: list[dict], out_path: Path) -> None:
    lines = []
    for idx, seg in enumerate(segments, 1):
        lines.append(str(idx))
        lines.append(f"{fmt_srt_timestamp(seg['start'])} --> {fmt_srt_timestamp(seg['end'])}")
        lines.append(seg["text"].strip())
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def render_srt_bilingual(en_segments: list[dict], zh_segments: list[dict], out_path: Path) -> None:
    paired = align_bilingual_segments(en_segments, zh_segments)
    lines = []
    for idx, (en_segment, zh_segment) in enumerate(paired, 1):
        zh = rzp.clean_zh(zh_segment["text"].strip())
        en = en_segment["text"].strip()
        lines.append(str(idx))
        lines.append(f"{fmt_srt_timestamp(en_segment['start'])} --> {fmt_srt_timestamp(en_segment['end'])}")
        if zh:
            lines.append(zh)
        if en:
            lines.append(en)
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def prepare_input_media(src: Path, job_dir: Path, log: LogFn = default_log) -> tuple[str, Path]:
    media_type = classify_input(src)
    if media_type == "audio":
        return media_type, src
    out_audio = job_dir / f"{src.stem}.m4a"
    if (job_dir / "gladia_raw.json").is_file():
        log(f"[extract] reuse completed transcript instead of extracting {src.name} again")
        return media_type, out_audio
    if not out_audio.exists():
        extract_audio_for_video(src, out_audio, log=log)
    else:
        log(f"[extract] reuse existing audio: {out_audio}")
    return media_type, out_audio


def cleanup_intermediate_audio(
    media_type: str,
    media_path: Path,
    job_dir: Path,
    log: LogFn = default_log,
) -> None:
    """Remove only video-derived audio after the final output is complete."""
    if media_type != "video":
        return

    try:
        resolved_media = media_path.resolve()
        resolved_job_dir = job_dir.resolve()
        if resolved_media.parent != resolved_job_dir:
            log(f"[cleanup] skipped unsafe intermediate path: {media_path}")
            return
        resolved_media.unlink(missing_ok=True)
        log(f"[cleanup] removed intermediate audio: {media_path.name}")
    except OSError as exc:
        # Cleanup failure must not invalidate a successfully generated transcript.
        log(f"[cleanup] warning: could not remove intermediate audio {media_path}: {exc}")


def choose_output_path(src: Path, output_dir: Path | None, fmt: str) -> Path:
    base_dir = output_dir if output_dir else src.parent
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir / f"{src.stem}.{fmt}"


def source_signature(source: Path) -> dict:
    stat = source.stat()
    return {"path": str(source.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _key_fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _saved_job_id(job_dir: Path, request: dict) -> str:
    if request.get("status") == "failed":
        return ""
    legacy_path = job_dir / "gladia_raw.job_id"
    return request.get("job_id") or (legacy_path.read_text(encoding="utf-8").strip() if legacy_path.exists() else "")


def _fetch_audio_transcript(
    media_path: Path,
    job_dir: Path,
    config: PipelineConfig,
    rotator,
    signature: dict,
    report: Callable[[str], None],
    log: LogFn,
) -> dict:
    raw_path = job_dir / "gladia_raw.json"
    if raw_path.is_file():
        report("Reusing completed transcript")
        return json.loads(raw_path.read_text(encoding="utf-8"))
    request_path = job_dir / "gladia_request.json"
    job_id_path = job_dir / "gladia_raw.job_id"
    request = json.loads(request_path.read_text(encoding="utf-8")) if request_path.exists() else {}
    job_id = _saved_job_id(job_dir, request)
    if not job_id:
        languages, code_switching = language_config_for_mode(config.source_language)
        while True:
            try:
                report("Uploading audio")
                audio_url = g.upload(rotator, src=media_path)
                report("Submitting transcription")
                job_id = g.transcribe(rotator, audio_url, languages=languages, code_switching=code_switching)
                break
            except g.AudioUrlKeyMismatch as exc:
                failed_index = rotator.idx
                rotator.mark_bad(failed_index, reason=str(exc))
                try:
                    rotator.rotate(reason=str(exc))
                except g.KeyRotatorExhausted:
                    raise RuntimeError("all Gladia keys were rejected by the remote API") from exc
                log(f"[stt] remote rejected key#{failed_index + 1}; retrying with key#{rotator.idx + 1}")
        request = {"job_id": job_id, "key_fingerprint": _key_fingerprint(rotator.current), "source": signature}
        write_json_atomic(request_path, request)
        job_id_path.write_text(job_id, encoding="utf-8")
    else:
        log(f"[stt] resume saved transcription job_id={job_id}")
    fingerprint = request.get("key_fingerprint")
    if fingerprint:
        candidates = [key for key in rotator.keys if _key_fingerprint(key) == fingerprint]
        if not candidates:
            raise RuntimeError("Restore the original Gladia key to resume this saved transcription job")
    else:
        # Old jobs did not record their submitting key. Only retry authorization errors.
        candidates = list(dict.fromkeys([rotator.current, *rotator.keys]))
    report("Waiting for transcription result")
    for key in candidates:
        try:
            result = wait_for_gladia_result(key, job_id, poll_interval=config.poll_interval, max_iters=config.poll_max_iters)
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in {401, 403}:
                raise
        except GladiaJobFailedError as exc:
            write_json_atomic(request_path, {**request, "job_id": job_id, "source": signature,
                                            "status": "failed", "error": str(exc)})
            raise
    else:
        raise RuntimeError("No configured Gladia key can read this saved transcription job; restore its original key")
    if not fingerprint:
        write_json_atomic(request_path, {"job_id": job_id, "key_fingerprint": _key_fingerprint(key), "source": signature})
    write_raw_result(result, job_id, raw_path, job_dir / "gladia_zh.json")
    return json.loads(raw_path.read_text(encoding="utf-8"))


def _transcribe_long_audio(
    media_path: Path, job_dir: Path, metadata: dict, config: PipelineConfig, rotator,
    signature: dict, report: Callable[[str], None], log: LogFn,
) -> dict:
    plan_path = job_dir / "audio_parts.json"
    if plan_path.exists():
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        if plan.get("source") != signature or plan.get("max_seconds") != config.max_audio_seconds:
            raise RuntimeError("The recording or chunk limit changed; remove this job's cache before processing it again")
    else:
        plan = {**metadata, "parts": plan_audio_parts(metadata["duration_seconds"], config.max_audio_seconds),
                "source": signature, "max_seconds": config.max_audio_seconds}
        write_json_atomic(plan_path, plan)
    ffmpeg = find_binary("ffmpeg", FFMPEG_FALLBACK)
    ffprobe = find_binary("ffprobe", FFPROBE_FALLBACK)
    log(f"[split] {plan['duration_seconds']:.3f}s -> {len(plan['parts'])} parts; serial transcription")
    transcripts = []
    for part in plan["parts"]:
        label = f"Part {part['index'] + 1}/{len(plan['parts'])}"
        part_dir = job_dir / "audio_parts" / f"part_{part['index'] + 1:04d}"
        part_dir.mkdir(parents=True, exist_ok=True)
        audio_path = part_dir / f"{media_path.stem}.part-{part['index'] + 1:04d}{chunk_extension(plan['codec'])}"
        request_path = part_dir / "gladia_request.json"
        request = json.loads(request_path.read_text(encoding="utf-8")) if request_path.exists() else {}
        has_checkpoint = (part_dir / "gladia_raw.json").exists() or bool(_saved_job_id(part_dir, request))
        if not has_checkpoint:
            report(f"{label}: preparing {part['duration_seconds']:.3f}s audio")
            audio_path = prepare_audio_part(media_path, audio_path, part, plan["codec"], ffmpeg, ffprobe)
        transcript = _fetch_audio_transcript(
            audio_path, part_dir, config, rotator, signature,
            lambda detail, label=label: report(f"{label}: {detail}"), log,
        )
        transcripts.append(transcript)
        report(f"{label}: transcript saved")
    raw = merge_part_transcripts(plan["parts"], transcripts, plan["duration_seconds"])
    raw["_fetch_ts"] = time.time()
    write_json_atomic(job_dir / "gladia_raw.json", raw)
    (job_dir / "gladia_raw.job_id").write_text("chunked", encoding="utf-8")
    report(f"Merged {len(plan['parts'])} audio parts into one transcript")
    return raw


def cleanup_audio_parts(job_dir: Path, log: LogFn = default_log) -> None:
    parts_root = job_dir / "audio_parts"
    if not parts_root.is_dir():
        return
    for audio in parts_root.rglob("*"):
        if audio.is_file() and audio.suffix.lower() in AUDIO_EXTS:
            try:
                if audio.resolve().is_relative_to(job_dir.resolve()):
                    audio.unlink()
                    log(f"[cleanup] removed audio chunk: {audio.name}")
            except OSError as exc:
                log(f"[cleanup] warning: could not remove audio chunk {audio.name}: {exc}")


def ensure_transcript_artifacts(
    media_path: Path,
    job_dir: Path,
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
    *,
    source_path: Path | None = None,
) -> tuple[list[dict], Path, Path, list[str], bool]:
    keys = g.load_keys()
    rotator = g.KeyRotator(keys)

    raw_path = job_dir / "gladia_raw.json"
    clean_path = job_dir / "utt_clean.json"
    zh_path = job_dir / "gladia_zh.json"

    original = source_path or media_path
    signature = source_signature(original)
    source_path_record = job_dir / "transcription_source.json"
    if source_path_record.exists() and json.loads(source_path_record.read_text(encoding="utf-8")) != signature:
        raise RuntimeError("The source recording changed; remove this job's cache before processing it again")
    write_json_atomic(source_path_record, signature)

    def report(detail: str) -> None:
        log(f"[stt] {detail}")
        stage_callback(original, "stt", detail)

    if raw_path.exists():
        report("Reusing completed transcript")
        raw_data = json.loads(raw_path.read_text(encoding="utf-8"))
    else:
        metadata = probe_audio(find_binary("ffprobe", FFPROBE_FALLBACK), media_path)
        plan_audio_parts(metadata["duration_seconds"], config.max_audio_seconds)
        if metadata["duration_seconds"] > config.max_audio_seconds:
            raw_data = _transcribe_long_audio(media_path, job_dir, metadata, config, rotator, signature, report, log)
        else:
            raw_data = _fetch_audio_transcript(media_path, job_dir, config, rotator, signature, report, log)
    if not zh_path.exists():
        write_json_atomic(zh_path, {
            **{key: value for key, value in raw_data.items() if key != "segments"},
            "segments_en": raw_data["segments"], "segments_zh": [], "_fetch_stage": "source-transcript",
        })
    detected_languages = raw_data.get("languages", [])
    if not detected_languages and raw_data.get("language") not in {None, "unknown"}:
        detected_languages = [raw_data["language"]]
    english_only = config.source_language == "en" or (
        config.source_language == "auto"
        and bool(detected_languages)
        and all(str(language).lower().startswith("en") for language in detected_languages)
    )

    if english_only:
        log("[dedup] running English transcript cleanup")
        stage_callback(original, "dedup", "Cleaning English transcript segments")
        clean_segments = run_dedup(raw_path, clean_path)
    else:
        log("[dedup] preserving source-language transcript")
        stage_callback(original, "dedup", "Preserving source-language segments")
        clean_segments = raw_data.get("segments", [])
        clean_path.write_text(
            json.dumps(clean_segments, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return clean_segments, clean_path, zh_path, detected_languages, english_only


def render_output(
    source_path: Path,
    en_segments: list[dict],
    zh_path: Path,
    config: PipelineConfig,
    can_translate_to_chinese: bool,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> tuple[Path, bool]:
    out_path = choose_output_path(source_path, config.output_dir, config.output_format)
    translated = config.translate and can_translate_to_chinese
    if translated:
        provider = normalize_translation_provider(config.translation_provider)
        provider_label = translation_provider_label(provider)
        log(f"[translate] running {provider_label} streaming translation")
        stage_callback(source_path, "translate", f"Translating to Chinese with {provider_label}")
        llm_translate.main(
            [str(zh_path.parent / "utt_clean.json"), str(zh_path), provider]
        )
        data = json.loads(zh_path.read_text(encoding="utf-8"))
        zh_segments = data.get("segments_zh", [])
        stage_callback(source_path, "render", f"Writing {config.output_format} output")
        if config.output_format == "txt":
            render_txt_bilingual(en_segments, zh_segments, out_path)
        else:
            render_srt_bilingual(en_segments, zh_segments, out_path)
    else:
        if config.translate and not can_translate_to_chinese:
            log("[translate] skipped: source is Chinese, mixed-language, or was not detected as English")
        log(f"[render] writing {config.output_format} without translation")
        stage_callback(source_path, "render", f"Writing {config.output_format} output")
        if config.output_format == "txt":
            render_txt_en(en_segments, out_path)
        else:
            render_srt_en(en_segments, out_path)
    return out_path, translated


def process_one(
    source_path: Path,
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> PipelineResult:
    job_tag = f"{stable_job_tag(source_path)}__{config.source_language}"
    job_dir = config.jobs_root / job_tag
    job_dir.mkdir(parents=True, exist_ok=True)

    stage_callback(source_path, "prepare", "Preparing input media")
    media_type, media_path = prepare_input_media(source_path, job_dir, log=log)
    clean_segments, _clean_path, zh_path, detected_languages, english_only = ensure_transcript_artifacts(
        media_path,
        job_dir,
        config,
        log=log,
        stage_callback=stage_callback,
        source_path=source_path,
    )
    if detected_languages:
        log(f"[stt] detected language(s): {', '.join(detected_languages)}")
    output_path, translated = render_output(
        source_path,
        clean_segments,
        zh_path,
        config,
        can_translate_to_chinese=english_only,
        log=log,
        stage_callback=stage_callback,
    )
    cleanup_intermediate_audio(media_type, media_path, job_dir, log=log)
    cleanup_audio_parts(job_dir, log=log)
    stage_callback(source_path, "done", f"Created {output_path.name}")
    return PipelineResult(
        source_path=source_path,
        media_type=media_type,
        prepared_audio_path=media_path,
        output_path=output_path,
        job_dir=job_dir,
        translated=translated,
        output_format=config.output_format,
    )


def process_many(
    paths: list[Path],
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> tuple[list[PipelineResult], list[tuple[Path, Exception]]]:
    results: list[PipelineResult] = []
    failures: list[tuple[Path, Exception]] = []
    config.jobs_root.mkdir(parents=True, exist_ok=True)
    for source_path in paths:
        log(f"\n=== Processing: {source_path} ===")
        try:
            result = process_one(source_path, config, log=log, stage_callback=stage_callback)
            log(f"OK -> {result.output_path}")
            results.append(result)
        except Exception as exc:  # noqa: BLE001
            log(f"FAIL -> {source_path}: {exc}")
            stage_callback(source_path, "failed", str(exc))
            failures.append((source_path, exc))
    return results, failures


def expand_inputs(items: list[str]) -> list[Path]:
    result: list[Path] = []
    for item in items:
        matches = list(Path().glob(item)) if any(ch in item for ch in "*?[]") else [Path(item)]
        for match in matches:
            path = match.resolve()
            if not path.exists():
                raise FileNotFoundError(path)
            if path.is_dir():
                for child in sorted(path.iterdir()):
                    if child.is_file() and child.suffix.lower() in SUPPORTED_EXTS:
                        result.append(child.resolve())
            elif path.suffix.lower() in SUPPORTED_EXTS:
                result.append(path)
            else:
                raise ValueError(f"unsupported media type: {path}")
    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in result:
        if path not in seen:
            deduped.append(path)
            seen.add(path)
    return deduped
