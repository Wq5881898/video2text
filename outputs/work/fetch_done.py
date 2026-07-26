#!/usr/bin/env python3
"""从 Gladia 拉已 done 的 job 结果到本地, 不轮询 (job 必须已 done).

URL 已切到 v2/pre-recorded (官方推荐), header 用 x-gladia-key.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
KEYS_FILE = SCRIPT_DIR / "keys"
BASE = "https://api.gladia.io/v2"


def load_key():
    for line in KEYS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    sys.exit("no key")


def http_get(url, key):
    req = urllib.request.Request(url, headers={"x-gladia-key": key})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read())


def normalize(result):
    """跟 gladia.py normalize 保持一致, 容错补 0.
    
    新版返回字段:
      start, end, speaker, text, confidence
    """
    out = []
    utterances = result.get("transcription", {}).get("utterances", [])
    if utterances:
        for utt in utterances:
            out.append({
                "start": round(utt.get("start", 0.0), 2),
                "end": round(utt.get("end", 0.0), 2),
                "speaker": utt.get("speaker"),
                "text": (utt.get("text") or "").strip(),
                "confidence": utt.get("confidence"),
            })
        return out
    full = result.get("transcription", {}).get("full_transcript")
    if full:
        out.append({
            "start": 0.0,
            "end": result.get("metadata", {}).get("audio_duration", 0.0),
            "speaker": None,
            "text": full.strip(),
            "confidence": None,
        })
    return out


def fetch(tag, key):
    out_dir = SCRIPT_DIR / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    jf = out_dir / "gladia_raw.job_id"
    if not jf.exists():
        print(f"[{tag}] no job_id, skip", flush=True)
        return False
    job_id = jf.read_text().strip()
    raw_path = out_dir / "gladia_raw.json"
    if raw_path.exists() and raw_path.stat().st_size > 100:
        d = json.load(open(raw_path))
        if d.get("segments"):
            print(f"[{tag}] already fetched ({len(d['segments'])} segs)", flush=True)
            return True
    url = f"{BASE}/pre-recorded/{job_id}"
    status, data = http_get(url, key)
    if status != 200:
        print(f"[{tag}] fetch fail: {status}", flush=True)
        return False
    s = data.get("status")
    if s != "done":
        print(f"[{tag}] not done yet: {s}", flush=True)
        return False
    result = data["result"]
    segments = normalize(result)
    # 官方返回的子句级 / 章节 / 摘要 / SRT 都保留
    meta = result.get("metadata", {})
    out = {
        "duration": meta.get("audio_duration") or meta.get("duration"),
        "language": "en",
        "segments": segments,
        "summary": result.get("summarization", {}).get("results") if "summarization" in result else None,
        "chapters": result.get("chapterization", {}).get("results") if "chapterization" in result else None,
        "subtitles_srt": ((result.get("subtitles") or [{}])[0].get("subtitles") if isinstance(result.get("subtitles"), list) and result.get("subtitles") else None),
    }
    raw_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{tag}] OK -> {raw_path}, {len(segments)} utterances", flush=True)
    return True


if __name__ == "__main__":
    tags = sys.argv[1:] or [d.name for d in SCRIPT_DIR.iterdir() if d.is_dir() and (d / "gladia_raw.job_id").exists()]
    key = load_key()
    ok = 0
    for t in tags:
        if fetch(t, key):
            ok += 1
        time.sleep(0.5)
    print(f"\nfetched {ok}/{len(tags)}", flush=True)
