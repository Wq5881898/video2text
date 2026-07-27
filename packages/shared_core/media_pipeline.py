from __future__ import annotations

import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else REPO_ROOT
WORK_ROOT = RUNTIME_ROOT / "outputs" / "work"
CONFIG_ROOT = RUNTIME_ROOT / "config"
if str(WORK_ROOT) not in sys.path:
    sys.path.insert(0, str(WORK_ROOT))

import deepl_translate
import gladia as g
import run_zh_pipeline as rzp


LogFn = Callable[[str], None]
StageFn = Callable[[Path, str, str], None]
AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma", ".m4b"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v"}
SUPPORTED_EXTS = AUDIO_EXTS | VIDEO_EXTS
FFMPEG_FALLBACK = Path(r"D:\program\ffmpeg\bin\ffmpeg.exe")
FFPROBE_FALLBACK = Path(r"D:\program\ffmpeg\bin\ffprobe.exe")
DEFAULT_JOBS_ROOT = WORK_ROOT / "jobs"
GLADIA_KEYS_PATH = CONFIG_ROOT / "gladia_keys.txt"
DEEPL_KEY_PATH = CONFIG_ROOT / "deepl_key.txt"


def runtime_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return REPO_ROOT


def bundled_binary(name: str) -> Path | None:
    candidate = runtime_root() / "bin" / f"{name}.exe"
    return candidate if candidate.exists() else None


@dataclass(slots=True)
class PipelineConfig:
    output_format: str
    translate: bool
    output_dir: Path | None = None
    jobs_root: Path = DEFAULT_JOBS_ROOT
    poll_interval: int = 8
    poll_max_iters: int = 90


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


def default_log(message: str) -> None:
    print(message, flush=True)


def default_stage_callback(_source_path: Path, _stage: str, _detail: str) -> None:
    return


def _has_nonempty_file(path: Path) -> bool:
    return path.exists() and bool(path.read_text(encoding="utf-8").strip())


def collect_environment_checks(*, needs_translation: bool, needs_video_tools: bool) -> list[EnvironmentCheck]:
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

    deepl_env = bool(os.environ.get("DEEPL_KEY", "").strip())
    deepl_file = _has_nonempty_file(DEEPL_KEY_PATH)
    if needs_translation:
        checks.append(
            EnvironmentCheck(
                "deepl",
                deepl_env or deepl_file,
                "DEEPL_KEY env" if deepl_env else (str(DEEPL_KEY_PATH) if deepl_file else f"Missing {DEEPL_KEY_PATH}"),
            )
        )
    else:
        checks.append(EnvironmentCheck("deepl", True, "Not needed when translation is off"))

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
            str(out_audio),
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
            str(out_audio),
        ]
        log("[extract] mode=left-channel to mono AAC")
    subprocess.run(cmd, check=True)


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
            raise RuntimeError(f"Gladia job failed: {payload}")
        time.sleep(poll_interval)
    raise TimeoutError(f"Gladia polling timeout for job {job_id}")


def write_raw_result(result: dict, job_id: str, raw_path: Path, zh_path: Path) -> list[dict]:
    en_segments = [
        {
            "start": round(u["start"], 2),
            "end": round(u["end"], 2),
            "speaker": u.get("speaker"),
            "text": u["text"].strip(),
            "confidence": u.get("confidence"),
        }
        for u in result.get("transcription", {}).get("utterances", [])
    ]
    raw_data = {
        "duration": result.get("metadata", {}).get("audio_duration"),
        "language": "en",
        "segments": en_segments,
        "job_id": job_id,
        "_fetch_ts": time.time(),
    }
    raw_path.write_text(json.dumps(raw_data, ensure_ascii=False, indent=2), encoding="utf-8")
    zh_data = {
        "duration": result.get("metadata", {}).get("audio_duration"),
        "language": "en",
        "segments_en": en_segments,
        "segments_zh": [],
        "job_id": job_id,
        "_fetch_ts": time.time(),
        "_fetch_stage": "en-only",
    }
    zh_path.write_text(json.dumps(zh_data, ensure_ascii=False, indent=2), encoding="utf-8")
    return en_segments


def run_dedup(raw_path: Path, out_path: Path) -> list[dict]:
    dedup_script = WORK_ROOT / "dedup.py"
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
    paired = rzp.pair_en_zh(en_segments, zh_segments)
    lines = []
    for entry in paired:
        zh = rzp.clean_zh(entry.get("text_zh", "").strip())
        en = entry.get("text_en", "").strip()
        if zh:
            lines.append(zh)
        if en:
            lines.append(en)
        lines.append("")
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def fmt_srt_timestamp(value: float) -> str:
    h = int(value // 3600)
    m = int((value % 3600) // 60)
    s = value % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def render_srt_en(segments: list[dict], out_path: Path) -> None:
    lines = []
    for idx, seg in enumerate(segments, 1):
        lines.append(str(idx))
        lines.append(f"{fmt_srt_timestamp(seg['start'])} --> {fmt_srt_timestamp(seg['end'])}")
        lines.append(seg["text"].strip())
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def render_srt_bilingual(en_segments: list[dict], zh_segments: list[dict], out_path: Path) -> None:
    paired = rzp.pair_en_zh(en_segments, zh_segments)
    lines = []
    for idx, entry in enumerate(paired, 1):
        zh = rzp.clean_zh(entry.get("text_zh", "").strip())
        en = entry.get("text_en", "").strip()
        lines.append(str(idx))
        lines.append(f"{fmt_srt_timestamp(entry['start'])} --> {fmt_srt_timestamp(entry['end'])}")
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
    if not out_audio.exists():
        extract_audio_for_video(src, out_audio, log=log)
    else:
        log(f"[extract] reuse existing audio: {out_audio}")
    return media_type, out_audio


def choose_output_path(src: Path, output_dir: Path | None, fmt: str) -> Path:
    base_dir = output_dir if output_dir else src.parent
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir / f"{src.stem}.{fmt}"


def ensure_transcript_artifacts(
    media_path: Path,
    job_dir: Path,
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> tuple[list[dict], Path, Path]:
    keys = g.load_keys()
    rotator = g.KeyRotator(keys)
    idx = g.find_working_key(rotator, force=True)
    if idx is None:
        raise RuntimeError("no working Gladia key available")
    rotator.use(idx)

    job_id_path = job_dir / "gladia_raw.job_id"
    raw_path = job_dir / "gladia_raw.json"
    clean_path = job_dir / "utt_clean.json"
    zh_path = job_dir / "gladia_zh.json"

    if job_id_path.exists() and raw_path.exists():
        job_id = job_id_path.read_text(encoding="utf-8").strip()
        log(f"[stt] reuse existing job_id={job_id}")
        stage_callback(media_path, "stt", "Reusing transcript job")
    else:
        log(f"[stt] upload/transcribe: {media_path.name}")
        stage_callback(media_path, "stt", "Uploading audio")
        audio_url = g.upload(rotator, src=media_path)
        stage_callback(media_path, "stt", "Submitting transcription")
        job_id = g.transcribe(rotator, audio_url)
        job_id_path.write_text(job_id, encoding="utf-8")
        stage_callback(media_path, "stt", "Waiting for transcription result")
        result = wait_for_gladia_result(
            rotator.current,
            job_id,
            poll_interval=config.poll_interval,
            max_iters=config.poll_max_iters,
        )
        write_raw_result(result, job_id, raw_path, zh_path)

    if not raw_path.exists():
        log("[stt] raw result missing, refetching")
        stage_callback(media_path, "stt", "Refetching transcript result")
        result = wait_for_gladia_result(
            rotator.current,
            job_id,
            poll_interval=config.poll_interval,
            max_iters=config.poll_max_iters,
        )
        write_raw_result(result, job_id, raw_path, zh_path)

    log("[dedup] running dedup.py")
    stage_callback(media_path, "dedup", "Cleaning transcript segments")
    en_clean = run_dedup(raw_path, clean_path)
    return en_clean, clean_path, zh_path


def render_output(
    source_path: Path,
    en_segments: list[dict],
    zh_path: Path,
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> Path:
    out_path = choose_output_path(source_path, config.output_dir, config.output_format)
    if config.translate:
        log("[translate] running DeepL translation")
        stage_callback(source_path, "translate", "Translating to Chinese")
        deepl_translate.main([str(zh_path.parent / "utt_clean.json"), str(zh_path)])
        data = json.loads(zh_path.read_text(encoding="utf-8"))
        zh_segments = data.get("segments_zh", [])
        stage_callback(source_path, "render", f"Writing {config.output_format} output")
        if config.output_format == "txt":
            render_txt_bilingual(en_segments, zh_segments, out_path)
        else:
            render_srt_bilingual(en_segments, zh_segments, out_path)
    else:
        log(f"[render] writing {config.output_format} without translation")
        stage_callback(source_path, "render", f"Writing {config.output_format} output")
        if config.output_format == "txt":
            render_txt_en(en_segments, out_path)
        else:
            render_srt_en(en_segments, out_path)
    return out_path


def process_one(
    source_path: Path,
    config: PipelineConfig,
    log: LogFn = default_log,
    stage_callback: StageFn = default_stage_callback,
) -> PipelineResult:
    job_tag = stable_job_tag(source_path)
    job_dir = config.jobs_root / job_tag
    job_dir.mkdir(parents=True, exist_ok=True)

    stage_callback(source_path, "prepare", "Preparing input media")
    media_type, media_path = prepare_input_media(source_path, job_dir, log=log)
    en_clean, _clean_path, zh_path = ensure_transcript_artifacts(
        media_path,
        job_dir,
        config,
        log=log,
        stage_callback=stage_callback,
    )
    output_path = render_output(
        source_path,
        en_clean,
        zh_path,
        config,
        log=log,
        stage_callback=stage_callback,
    )
    stage_callback(source_path, "done", f"Created {output_path.name}")
    return PipelineResult(
        source_path=source_path,
        media_type=media_type,
        prepared_audio_path=media_path,
        output_path=output_path,
        job_dir=job_dir,
        translated=config.translate,
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
