from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
from pathlib import Path


MAX_AUDIO_SECONDS = 8000.0
CHUNK_TARGET_SECONDS = 7998.0


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run_media_tool(args: list[str]) -> str:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Audio preparation failed: {exc.stderr[-2000:]}") from exc
    return result.stdout


def probe_audio(ffprobe: str, source: Path) -> dict:
    data = json.loads(run_media_tool([
        ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,duration:format=duration", "-of", "json", str(source),
    ]))
    stream = next(iter(data.get("streams", [])), None)
    if stream is None:
        raise RuntimeError(f"The source file has no audio track: {source}")
    try:
        duration = float(stream.get("duration", "nan"))
    except (TypeError, ValueError):
        duration = math.nan
    if not math.isfinite(duration) or duration <= 0:
        try:
            duration = float(data.get("format", {}).get("duration", "nan"))
        except (TypeError, ValueError):
            duration = math.nan
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"Could not determine the audio duration: {source}")
    return {"duration_seconds": duration, "codec": stream.get("codec_name", "")}


def plan_audio_parts(duration: float, max_seconds: float = MAX_AUDIO_SECONDS) -> list[dict]:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Audio duration must be positive and finite")
    if not math.isfinite(max_seconds) or not 2 < max_seconds <= MAX_AUDIO_SECONDS:
        raise ValueError("Audio chunk limit must be greater than 2 and at most 8000 seconds")
    count = 1 if duration <= max_seconds else math.ceil(duration / min(CHUNK_TARGET_SECONDS, max_seconds - 2))
    seconds = duration / count
    return [{
        "index": index,
        "offset_seconds": index * seconds,
        "duration_seconds": min(seconds, duration - index * seconds),
    } for index in range(count)]


def chunk_extension(codec: str) -> str:
    return {"aac": ".m4a", "alac": ".m4a", "mp3": ".mp3", "flac": ".flac", "opus": ".ogg", "vorbis": ".ogg"}.get(
        codec, ".wav" if codec.startswith("pcm_") else ".m4a"
    )


def prepare_audio_part(source: Path, destination: Path, part: dict, codec: str, ffmpeg: str, ffprobe: str) -> Path:
    if source.resolve() == destination.resolve():
        raise ValueError("A chunk must never overwrite the original recording")
    if destination.is_file() and destination.stat().st_size:
        try:
            duration = probe_audio(ffprobe, destination)["duration_seconds"]
            if duration <= MAX_AUDIO_SECONDS and abs(duration - part["duration_seconds"]) <= 1:
                return destination
        except RuntimeError:
            pass
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.stem}.preparing{destination.suffix}")
    arguments = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", str(part["offset_seconds"]),
        "-i", str(source), "-t", str(part["duration_seconds"]), "-map", "0:a:0", "-vn",
    ]
    can_copy = codec in {"aac", "alac", "mp3", "flac", "opus", "vorbis"} or codec.startswith("pcm_")
    try:
        if can_copy:
            try:
                run_media_tool(arguments + ["-c:a", "copy", "-avoid_negative_ts", "make_zero", str(temporary)])
            except RuntimeError:
                can_copy = False
        if not can_copy:
            # A failed stream copy may still decode successfully; convert to M4A.
            if destination.suffix != ".m4a":
                temporary.unlink(missing_ok=True)
                destination = destination.with_suffix(".m4a")
                temporary = destination.with_name(f".{destination.stem}.preparing.m4a")
            run_media_tool(arguments + ["-c:a", "aac", "-b:a", "96k", "-ac", "1", str(temporary)])
        actual = probe_audio(ffprobe, temporary)["duration_seconds"]
        if actual > MAX_AUDIO_SECONDS or not temporary.stat().st_size or abs(actual - part["duration_seconds"]) > 1:
            raise RuntimeError(f"Prepared chunk duration is invalid: planned={part['duration_seconds']}, actual={actual}")
        temporary.replace(destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


def merge_part_transcripts(parts: list[dict], transcripts: list[dict], duration: float) -> dict:
    if len(parts) != len(transcripts):
        raise ValueError("Every audio part must have a completed transcript before merging")
    segments = []
    languages = []
    job_ids = []
    for part, transcript in zip(parts, transcripts):
        job_ids.append(transcript["job_id"])
        for language in transcript.get("languages", []):
            if language and language not in languages:
                languages.append(language)
        for segment in transcript.get("segments", []):
            speaker = segment.get("speaker")
            segments.append({
                **segment,
                "start": round(segment["start"] + part["offset_seconds"], 3),
                "end": round(segment["end"] + part["offset_seconds"], 3),
                "speaker": f"part{part['index'] + 1}:{speaker}" if speaker is not None else None,
            })
    if not segments:
        raise RuntimeError("No speech was returned for any audio part")
    return {
        "duration": duration, "segments": segments, "languages": languages,
        "language": languages[0] if languages else "unknown", "job_id": "chunked", "job_ids": job_ids,
    }
