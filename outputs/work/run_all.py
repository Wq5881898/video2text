#!/usr/bin/env python3
"""run_all.py - 零 agent 一站式跑 N 期音频出 SRT.

状态机 (state.json):
  pending -> submitted -> fetched -> built
                |             |
                v             v
            submit_failed  fetch_failed (后续轮次会重试)

设计原则:
- 智能跳过已完成阶段, 重跑不会浪费 API quota
- 提供两种执行模式:
  * 分阶段 (submit/fetch/build): 单 bash 调用 45s 内完成, 多次推进
  * poll_all: 脚本内部轮询 (受 45s bash 限制需要外部 cron/scheduled-task 触发多次)

用法:
  python3 run_all.py submit 160629 160710 ...    # submit 阶段
  python3 run_all.py fetch  160629 160710 ...    # fetch 阶段
  python3 run_all.py build  160629 160710 ...    # build 阶段
  python3 run_all.py status                      # 查所有 tag 状态
  python3 run_all.py auto 160629 160710 ...      # submit + fetch + build (单次推进)
  python3 run_all.py poll_all [--max-secs 1800] [--sleep 10] 160629 ...
       # 脚本内部轮询, 全部 built 自动退出 + 写 RESULT.log
"""
import json
import os
import sys
import time
import traceback
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

import gladia as g
import gladia_with_translation as gwt
import run_zh_pipeline as rzp

DOWNLOAD_DIR = Path("/sessions/relaxed-peaceful-brown/mnt/DownloadTest")
WORK_ROOT = Path("/sessions/relaxed-peaceful-brown/mnt/local_ff4848c9-6ee7-4d9b-879f-d782bbfc0d8f/outputs/work")
STATE_FILE = WORK_ROOT / "run_all_state.json"
LOG_FILE = WORK_ROOT / "run_all.log"


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(s):
    STATE_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


def get_stage(state, tag):
    return state.get(tag, {}).get("stage", "pending"), state.get(tag, {})


def set_stage(state, tag, stage, **extra):
    state.setdefault(tag, {})
    state[tag]["stage"] = stage
    state[tag].update(extra)
    state[tag]["ts"] = time.time()
    save_state(state)


def find_tags(args):
    if args:
        return args
    tags = []
    for p in sorted(DOWNLOAD_DIR.glob("*.m4a")):
        srt = DOWNLOAD_DIR / f"{p.stem}.srt"
        if srt.exists():
            continue
        tags.append(p.stem)
    return tags


def stage_submit(rotator, tag):
    out_dir = WORK_ROOT / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    jf = out_dir / "gladia_raw.job_id"
    if jf.exists():
        job_id = jf.read_text().strip()
        if job_id:
            log(f"  [{tag}] skip submit, job_id={job_id} already on disk")
            return job_id
    audio = DOWNLOAD_DIR / f"{tag}.m4a"
    if not audio.exists():
        raise FileNotFoundError(audio)
    last_err = None
    for attempt in range(len(rotator.keys)):
        log(f"  [{tag}] upload attempt {attempt+1}/{len(rotator.keys)}")
        try:
            audio_url = g.upload(rotator, src=audio)
            job_id = gwt.transcribe_with_translation(rotator, audio_url)
            jf.write_text(job_id, encoding="utf-8")
            log(f"  [{tag}] submit OK, job_id={job_id}")
            return job_id
        except RuntimeError as e:
            last_err = e
            log(f"  [{tag}] attempt {attempt+1} failed: {e}")
            try:
                rotator.rotate(f"submit-retry: {e}")
            except SystemExit:
                raise
    raise RuntimeError(f"[{tag}] all {len(rotator.keys)} key(s) exhausted: {last_err}")


def stage_fetch(key, tag, job_id):
    d = WORK_ROOT / tag
    zh_path = d / "gladia_zh.json"
    if zh_path.exists() and zh_path.stat().st_size > 100:
        try:
            existing = json.load(open(zh_path))
            if existing.get("_fetch_ts") and existing.get("job_id") == job_id:
                log(f"  [{tag}] skip fetch, already have en+zh")
                return True
        except json.JSONDecodeError:
            pass
        zh_path.unlink()

    url = f"https://api.gladia.io/v2/pre-recorded/{job_id}"
    req = urllib.request.Request(url, headers={"x-gladia-key": key})
    raw = urllib.request.urlopen(req, timeout=30).read()
    full = json.loads(raw)
    status = full.get("status")
    log(f"  [{tag}] Gladia status={status}")
    if status != "done":
        return False

    r = full["result"]
    en = [{"start": round(u["start"], 2), "end": round(u["end"], 2),
           "speaker": u.get("speaker"), "text": u["text"].strip(),
           "confidence": u.get("confidence")}
          for u in r.get("transcription", {}).get("utterances", [])]
    zh = []
    for blk in r.get("translation", {}).get("results", []):
        langs = blk.get("languages", [])
        if isinstance(langs, list) and "zh" in langs:
            for u in blk.get("utterances", []):
                words = u.get("words", [])
                text = gwt._join_zh_words(words) if words else u.get("text", "").strip()
                if text:
                    zh.append({
                        "start": round(words[0]["start"], 2) if words else u.get("start", 0),
                        "end": round(words[-1]["end"], 2) if words else u.get("end", 0),
                        "speaker": u.get("speaker"),
                        "text": text,
                    })
            break
    out = {"duration": r["metadata"].get("audio_duration"), "language": "en",
           "segments_en": en, "segments_zh": zh,
           "_fetch_ts": time.time(), "job_id": job_id}
    zh_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  [{tag}] fetch OK, en={len(en)} zh={len(zh)} dur={out['duration']}s")
    return True


def stage_build(tag):
    srt_path = DOWNLOAD_DIR / f"{tag}.srt"
    zh_path = WORK_ROOT / tag / "gladia_zh.json"
    if srt_path.exists() and srt_path.stat().st_size > 1000:
        if srt_path.stat().st_mtime > zh_path.stat().st_mtime:
            log(f"  [{tag}] skip build, SRT exists and newer")
            return
    rzp.build_srt(tag)


def cmd_submit(args):
    tags = find_tags(args)
    if not tags:
        log("submit: no tag")
        return
    state = load_state()
    keys = g.load_keys()
    rotator = g.KeyRotator(keys)
    log(f"active: {rotator.current_label()}")
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("submitted", "fetched", "built"):
            log(f"[{tag}] skip submit, already {stage}")
            continue
        try:
            job_id = stage_submit(rotator, tag)
            set_stage(state, tag, "submitted", job_id=job_id)
        except Exception as e:
            log(f"[{tag}] submit FAIL: {e}")
            log(traceback.format_exc())
            set_stage(state, tag, "submit_failed", error=str(e))


def cmd_fetch(args):
    tags = find_tags(args)
    if not tags:
        log("fetch: no tag")
        return
    state = load_state()
    keys = g.load_keys()
    key = keys[-1]
    log(f"using key ...{key[-8:]}")
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("fetched", "built"):
            log(f"[{tag}] skip fetch, already {stage}")
            continue
        if stage != "submitted" or not data.get("job_id"):
            log(f"[{tag}] skip fetch, stage={stage}")
            continue
        try:
            if stage_fetch(key, tag, data["job_id"]):
                set_stage(state, tag, "fetched")
            else:
                log(f"  [{tag}] not done yet, leave for next call")
        except Exception as e:
            log(f"[{tag}] fetch FAIL: {e}")
            log(traceback.format_exc())


def cmd_build(args):
    tags = find_tags(args)
    if not tags:
        log("build: no tag")
        return
    state = load_state()
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage == "built":
            log(f"[{tag}] skip build, already built")
            continue
        if stage != "fetched":
            log(f"[{tag}] skip build, stage={stage}")
            continue
        try:
            stage_build(tag)
            set_stage(state, tag, "built")
        except Exception as e:
            log(f"[{tag}] build FAIL: {e}")
            log(traceback.format_exc())


def cmd_status(args):
    state = load_state()
    for tag in sorted(state.keys()):
        stage = state[tag].get("stage")
        job_id = state[tag].get("job_id", "-")[:20]
        srt = DOWNLOAD_DIR / f"{tag}.srt"
        srt_info = f" SRT={srt.stat().st_size}B" if srt.exists() else ""
        log(f"  [{tag}] {stage:14s} job_id={job_id}{srt_info}")


def write_result_log(tags):
    """给 agent 看的最终报告."""
    state = load_state()
    lines = [f"=== RESULT {time.strftime('%Y-%m-%d %H:%M:%S')} ==="]
    built_count = 0
    fail_count = 0
    for tag in sorted(tags):
        stage = state.get(tag, {}).get("stage", "pending")
        srt = DOWNLOAD_DIR / f"{tag}.srt"
        size = srt.stat().st_size if srt.exists() else 0
        if stage == "built" and srt.exists():
            status_line = f"OK ({size} B)"
            built_count += 1
        elif stage == "submit_failed":
            err = state[tag].get('error', '?')[:80]
            status_line = f"FAIL submit: {err}"
            fail_count += 1
        elif stage == "submitted":
            status_line = "submitted but not fetched yet"
        elif stage == "fetched":
            status_line = "fetched but not built yet"
        elif stage == "pending":
            status_line = "pending (not submitted)"
            fail_count += 1
        else:
            status_line = stage
        lines.append(f"  {tag}: {status_line}")
    lines.append(f"=== summary: {built_count}/{len(tags)} built, {fail_count} failed ===")
    result_file = WORK_ROOT / f"RESULT_{int(time.time())}.log"
    result_file.write_text("\n".join(lines), encoding="utf-8")
    log(f"=== RESULT written to {result_file.name} ===")
    (WORK_ROOT / "RESULT_LATEST.log").write_text("\n".join(lines), encoding="utf-8")


def cmd_poll_all(args):
    """脚本内部轮询, 直到所有 tag 都 built 或 timeout."""
    import argparse
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--max-secs", type=int, default=1800)
    ap.add_argument("--sleep", type=int, default=10)
    ap.add_argument("tags", nargs="*")
    opts, leftover = ap.parse_known_args(args)
    tags = find_tags(opts.tags)
    state = load_state()
    deadline = time.time() + opts.max_secs
    keys = g.load_keys()
    rotator = g.KeyRotator(keys)
    log(f"=== poll_all: {len(tags)} tag(s), max={opts.max_secs}s, sleep={opts.sleep}s ===")
    while time.time() < deadline:
        state = load_state()
        pending_submit = [t for t in tags if state.get(t, {}).get("stage") in ("pending", "submit_failed")]
        if pending_submit:
            cmd_submit(pending_submit)
        cmd_fetch(tags)
        cmd_build(tags)
        state = load_state()
        all_done = all(state.get(t, {}).get("stage") == "built" for t in tags)
        if all_done:
            log("=== poll_all: ALL BUILT ===")
            break
        log(f"=== poll_all: round done, sleeping {opts.sleep}s ===")
        time.sleep(opts.sleep)
    else:
        log("=== poll_all: TIMEOUT, not all built ===")
    cmd_status(tags)
    write_result_log(tags)


def main():
    if len(sys.argv) < 2:
        print("usage: run_all.py {submit|fetch|build|status|auto|poll_all} [tags...]", file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "submit":
        cmd_submit(args)
    elif cmd == "fetch":
        cmd_fetch(args)
    elif cmd == "build":
        cmd_build(args)
    elif cmd == "status":
        cmd_status(args)
    elif cmd == "auto":
        log("=== auto: submit pending ===")
        cmd_submit(args)
        log("=== auto: fetch done ===")
        cmd_fetch(args)
        log("=== auto: build ===")
        cmd_build(args)
        log("=== auto: status ===")
        cmd_status(args)
    elif cmd == "poll_all":
        cmd_poll_all(args)
    else:
        print(f"unknown cmd: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
