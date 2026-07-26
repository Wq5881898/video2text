#!/usr/bin/env python3
"""拉 Gladia 已 done job (含 zh 翻译) 到本地, 输出 gladia_zh.json.

跟 fetch_done.py 区别:
  - 同时拿 en utterances + zh utterances
  - 输出文件: {tag}/gladia_zh.json (格式跟 gladia_with_translation.py 一致)
  - 不动 gladia_raw.json, 跟原流程兼容

用法:
  python3 fetch_done_zh.py <TAG> [<TAG> ...]
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))
from gladia import load_keys, KeyRotator, BASE  # noqa
import gladia_with_translation as gwt  # noqa


def http_get(rotator, url, timeout=30):
    req = urllib.request.Request(url, headers={"x-gladia-key": rotator.current})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except Exception as e:
        return -1, str(e)


def fetch_one(tag, rotator):
    out_dir = SCRIPT_DIR / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    jf = out_dir / "gladia_raw.job_id"
    if not jf.exists():
        print(f"[{tag}] no job_id, skip", flush=True)
        return False
    job_id = jf.read_text().strip()
    zh_path = out_dir / "gladia_zh.json"
    if zh_path.exists() and zh_path.stat().st_size > 100:
        d = json.load(open(zh_path))
        if d.get("segments_en") and d.get("segments_zh"):
            print(f"[{tag}] already fetched (en={len(d['segments_en'])} zh={len(d['segments_zh'])})", flush=True)
            return True

    url = f"{BASE}/pre-recorded/{job_id}"
    status, data = http_get(rotator, url)
    if status != 200:
        print(f"[{tag}] fetch fail: {status} {str(data)[:100]}", flush=True)
        return False
    s = data.get("status")
    if s != "done":
        print(f"[{tag}] not done yet: {s}", flush=True)
        return False

    result = data["result"]
    en_segs, zh_segs = gwt.normalize_full(result)
    meta = result.get("metadata", {})
    out = {
        "duration": meta.get("audio_duration") or meta.get("duration"),
        "language": "en",
        "segments_en": en_segs,
        "segments_zh": zh_segs,
    }
    zh_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{tag}] OK -> {zh_path}, en={len(en_segs)} zh={len(zh_segs)}", flush=True)
    return True


def main():
    tags = sys.argv[1:] or [d.name for d in SCRIPT_DIR.iterdir() if d.is_dir() and (d / "gladia_raw.job_id").exists()]
    if not tags:
        sys.exit("usage: fetch_done_zh.py TAG [TAG ...]")

    keys = load_keys()
    rotator = KeyRotator(keys)
    print(f"active: {rotator.current_label()}", flush=True)

    ok = 0
    for i, t in enumerate(tags):
        try:
            if fetch_one(t, rotator):
                ok += 1
        except SystemExit as e:
            print(f"[{t}] SystemExit: {e}", flush=True)
            if str(e) == "3":
                break
        except Exception as e:
            print(f"[{t}] error: {e}", flush=True)
        if i < len(tags) - 1:
            time.sleep(1)

    print(f"\nfetched {ok}/{len(tags)}", flush=True)


if __name__ == "__main__":
    main()