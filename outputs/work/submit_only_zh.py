#!/usr/bin/env python3
"""只 submit (带 zh 翻译), 拿到 job_id 立即退出. 跨 bash 持久化进度.

跟 submit_only.py 区别:
  - 用 gladia_with_translation.transcribe_with_translation (带 translation.target_languages=["zh"])
  - job_id 写到 {tag}/gladia_raw.job_id
  - fetch_done.py 不变, 它只看 job_id 文件

用法:
  python3 submit_only_zh.py <TAG> [<TAG> ...]
"""
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))
from gladia import load_keys, KeyRotator, upload  # noqa
import gladia_with_translation as gwt  # noqa


def submit_one(tag, rotator):
    audio = Path(f"/sessions/relaxed-peaceful-brown/mnt/DownloadTest/{tag}.m4a")
    out_dir = SCRIPT_DIR / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    job_id_file = out_dir / "gladia_raw.job_id"

    if job_id_file.exists():
        print(f"[{tag}] already has job_id: {job_id_file.read_text().strip()}", flush=True)
        return True

    if not audio.exists():
        print(f"[{tag}] audio not found: {audio}", flush=True)
        return False

    print(f"[{tag}] submit {audio.name} ({audio.stat().st_size//1024} KB)...", flush=True)
    t0 = time.time()
    audio_url = upload(rotator, src=audio)
    t1 = time.time()
    print(f"[{tag}] upload done in {t1-t0:.1f}s", flush=True)
    job_id = gwt.transcribe_with_translation(rotator, audio_url)
    t2 = time.time()
    print(f"[{tag}] submit done in {t2-t1:.1f}s, job_id={job_id}", flush=True)
    job_id_file.write_text(job_id)
    return True


def main():
    tags = sys.argv[1:]
    if not tags:
        sys.exit("usage: submit_only_zh.py TAG [TAG ...]")

    keys = load_keys()
    rotator = KeyRotator(keys)
    print(f"active: {rotator.current_label()}", flush=True)

    ok = 0
    for i, tag in enumerate(tags):
        try:
            if submit_one(tag, rotator):
                ok += 1
        except SystemExit as e:
            print(f"[{tag}] SystemExit: {e}", flush=True)
            if str(e) == "3":  # keys exhausted
                break
        except Exception as e:
            print(f"[{tag}] error: {e}", flush=True)
        if i < len(tags) - 1:
            time.sleep(2)

    print(f"\nsubmitted {ok}/{len(tags)}", flush=True)


if __name__ == "__main__":
    main()