#!/usr/bin/env python3
r"""run_all_win.py - Windows 原生版 (不依赖 WSL).

路径规则:
- D:\DownloadTest\*.m4a 是输入 + 输出 SRT 目录
- keys 文件路径: 本脚本同目录 keys
- deeplkey.txt 路径: 本脚本同目录 deeplkey.txt
- state/log 文件: 本脚本同目录

5 阶段流水线 (2026-07 改, en-only + DeepL):
  submit -> fetch (en-only) -> dedup -> translate (DeepL) -> build

中间产物 (每期 work/<tag>/):
  gladia_raw.job_id       Gladia 提交凭证
  gladia_raw.json         原始 Gladia en 段 (不被任何后续 stage 覆盖, 便于核对 dedup 效果)
  gladia_zh.json          en + zh 合并 (DeepL 跑后写回)
  utt_clean.json          dedup 后的 en 段 (下一步给 DeepL 翻译)

状态机: pending -> submitted -> fetched -> deduped -> translated -> built
        (任一阶段失败 -> *_failed 状态, 下轮重试)

用法 (PowerShell / cmd 都行):
  python run_all_win.py auto          # 一键 (内部 1 小时轮询, 默认)
  python run_all_win.py one           # 一键 (内部 1 小时, bash 单调用, 自带 Gladia 排队等)
  python run_all_win.py status        # 查所有 tag 当前状态
  python run_all_win.py submit 160722 # 只跑 submit
  python run_all_win.py fetch  160722
  python run_all_win.py dedup  160722
  python run_all_win.py translate 160722
  python run_all_win.py build   160722

坑汇总 (本文件):
- 坑 AH: bwrap --die-with-parent 杀 detached python, 所以用 Windows 原生
- 坑 AN: state=built 但 SRT 不在磁盘时, 自动回退 pending 重跑 (sync_state_with_disk)
- 坑 AP: cmd_status 默认遍历 state.json 全集, one TAG 模式下只打印 TAG
- 坑 AQ: key 预检每次 submit 都重测废 key. 改为 cmd_submit 入口一次性预检,
         mid-run 失败 mark_bad, 下次直接跳过
- 坑 AX: stage_dedup 旧幂等逻辑比对 len(zh.segments_en)==len(utt_clean), 旧 zh
         跟旧 clean 对齐会永久跳过 dedup, 跑不到新 dedup → SRT 缺短段
         (160802 缺 "It's fun, it's bright,"). 改为强制重跑: 不比对 zh 段数,
         rename 旧 clean 为 .pre_rededup 再跑 (dedup 开销 <1s)
- 坑 AY: run_zh_pipeline.py 嵌一份 dedup_en() (Round 3 过杀), 流水线静默调它,
         不走外部 dedup.py. 但 run_all_win.py 没踩这个坑 (走的是外部 dedup.py),
         所以这个 audit fix 仅作用于 run_zh_pipeline.py 单期 driver 路径.
"""
import json
import os
import sys
import time
import traceback
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

import gladia as g
import deepl_translate
import run_zh_pipeline as rzp

# 跨平台路径识别: Windows 原生跑用 D:\; Linux/VM 跑用 FUSE mount 路径
def _detect_download_dir():
    win_guess = Path(r"D:\DownloadTest")
    if win_guess.exists():
        return win_guess
    vm_guess = SCRIPT_DIR.parent.parent.parent / "DownloadTest"
    if vm_guess.exists():
        return vm_guess
    return win_guess

DOWNLOAD_DIR = _detect_download_dir()
WORK_ROOT = SCRIPT_DIR  # outputs/work
STATE_FILE = WORK_ROOT / "run_all_state.json"
LOG_FILE = WORK_ROOT / "run_all.log"


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        bad = STATE_FILE.with_suffix(".json.bad")
        try:
            bad.write_text(STATE_FILE.read_text(encoding="utf-8"), encoding="utf-8")
            log(f"WARN: state.json corrupt ({e}); backed up to {bad.name}, using empty state")
        except Exception:
            log(f"WARN: state.json corrupt ({e}); using empty state")
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


def sync_state_with_disk(state, tags):
    """如果 state 标记 built 但磁盘上 SRT 缺失(或中间产物缺失), 自动回退到 pending.

    修复坑 AN: 用户手动清空 work/<tag>/, state.json 仍然说 built, 流水线不重跑.
    规则:
      - state=built 但 SRT 不在 -> reset to pending (重新走全流程)
      - state=fetched/deduped/translated/built 但 gladia_raw.json 不在 -> 如果
        gladia_raw.job_id 还在, 不 reset (可以从 job_id 恢复 fetch 状态 submitted),
        只在没有 job_id 时 reset pending.
    修复坑 AU/AV 2026-07-06: 避免死锁 (auto 跑时 state 被错误 reset 到 pending 但
    磁盘有 job_id, 导致 cmd_fetch 永远不会触发).
    """
    fixed = []
    for tag in tags:
        d = WORK_ROOT / tag
        srt = DOWNLOAD_DIR / f"{tag}.srt"
        job_id_file = d / "gladia_raw.job_id"
        stage = state.get(tag, {}).get("stage", "pending")
        if stage == "built":
            if not srt.exists():
                state[tag] = {"stage": "pending", "_reset": f"no SRT at {srt}", "ts": time.time()}
                fixed.append(f"{tag}: built -> pending (SRT missing)")
            elif not (d / "gladia_raw.json").exists():
                log(f"  WARN [{tag}] built SRT but no gladia_raw.json")
        elif stage in ("fetched", "deduped", "translated"):
            if not (d / "gladia_raw.json").exists():
                # 坑 AU/AV fix: 如果 job_id 文件还在, 把 stage 改回 submitted 而非 pending
                # 这样 cmd_fetch 能继续轮询这个 job_id 拿到结果
                if job_id_file.exists():
                    recovered_job_id = job_id_file.read_text().strip()
                    state[tag] = {
                        "stage": "submitted",
                        "job_id": recovered_job_id,
                        "_recovered": f"orphan job_id at {job_id_file}, raw missing, retry fetch",
                        "ts": time.time(),
                    }
                    fixed.append(f"{tag}: {stage} -> submitted (orphan job_id recover, retry fetch)")
                else:
                    state[tag] = {"stage": "pending", "_reset": f"no gladia_raw.json in {d}", "ts": time.time()}
                    fixed.append(f"{tag}: {stage} -> pending (raw missing)")
        elif stage == "pending":
            # 坑 AU fix: orphan job_id 文件存在但 state=pending (历史被 reset),
            # 自动恢复到 submitted 让 cmd_fetch 能继续
            if job_id_file.exists():
                recovered_job_id = job_id_file.read_text().strip()
                state[tag] = {
                    "stage": "submitted",
                    "job_id": recovered_job_id,
                    "_recovered": f"orphan job_id at {job_id_file}, state was pending",
                    "ts": time.time(),
                }
                fixed.append(f"{tag}: pending -> submitted (orphan job_id recover)")
    if fixed:
        save_state(state)
        for f in fixed:
            log(f"  [sync] {f}")


def find_tags(args):
    if args:
        return args
    tags = []
    if not DOWNLOAD_DIR.exists():
        log(f"ERROR: {DOWNLOAD_DIR} not exists")
        return tags
    for p in sorted(DOWNLOAD_DIR.glob("*.m4a")):
        srt = DOWNLOAD_DIR / f"{p.stem}.srt"
        if srt.exists():
            continue
        tags.append(p.stem)
    return tags


def precheck_keys(rotator):
    """启动时一次性预检 (坑 AQ): 找第一个能用的 key, 之后所有 tag 复用.

    Returns:
        idx (int) — 能用的 key 序号; None 表示所有 key 都废
    """
    log("  [precheck] 启动一次性预检 keys...")
    idx = g.find_working_key(rotator, force=True)
    if idx is None:
        return None
    rotator.use(idx)
    log(f"  [precheck] 选定 key#{idx+1}/{len(rotator.keys)} ...{rotator.current[-8:]}")
    return idx


def stage_submit(rotator, tag, prechecked_idx):
    """Stage 1: Gladia en-only submit.

    坑 AQ 2026-07-06: 不再自己预检. 用 cmd_submit 入口一次性预检好的 idx 直接 use.
    """
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
    # 复用 cmd_submit 入口预检好的 idx (启动只检一次)
    if prechecked_idx is None:
        raise RuntimeError(f"[{tag}] precheck 没找到可用 key, 跳过")
    if prechecked_idx in rotator.bad:
        raise RuntimeError(f"[{tag}] 预检 idx#{prechecked_idx+1} 已废, 跳过")
    rotator.use(prechecked_idx)
    log(f"  [{tag}] 用 key#{prechecked_idx+1}/{len(rotator.keys)} ...{rotator.current[-8:]} 上传+submit")
    try:
        audio_url = g.upload(rotator, src=audio)
        job_id = g.transcribe(rotator, audio_url)
        jf.write_text(job_id, encoding="utf-8")
        log(f"  [{tag}] submit OK (en-only), job_id={job_id}")
        return job_id
    except g.AudioUrlKeyMismatch as e:
        # 该 key 废了, mark_bad, 整个流水线需要换 key
        rotator.mark_bad(prechecked_idx, reason=f"AudioUrlKeyMismatch: {e}")
        raise RuntimeError(f"[{tag}] upload+submit key 配对失败: {e}") from e


def stage_fetch(key, tag, job_id):
    """Stage 2: 拉 Gladia 结果, 写 gladia_raw.json + gladia_zh.json (en-only)."""
    d = WORK_ROOT / tag
    zh_path = d / "gladia_zh.json"
    raw_path = d / "gladia_raw.json"
    if raw_path.exists() and raw_path.stat().st_size > 100:
        try:
            raw_existing = json.load(open(raw_path))
            if raw_existing.get("job_id") == job_id:
                log(f"  [{tag}] skip fetch, raw already on disk ({len(raw_existing.get('segments', []))} segments)")
                return True
        except json.JSONDecodeError:
            pass
    if zh_path.exists() and zh_path.stat().st_size > 100:
        try:
            existing = json.load(open(zh_path))
            if existing.get("_fetch_ts") and existing.get("job_id") == job_id:
                en_n = len(existing.get("segments_en", []))
                zh_n = len(existing.get("segments_zh", []))
                if zh_n > 0:
                    log(f"  [{tag}] skip fetch+translate, already have en+zh ({en_n}/{zh_n})")
                else:
                    log(f"  [{tag}] skip fetch, have en-only ({en_n}, translate pending)")
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
    raw_data = {
        "duration": r["metadata"].get("audio_duration"),
        "language": "en",
        "segments": en,
        "job_id": job_id,
        "_fetch_ts": time.time(),
        "_note": "Gladia 原始 en 转录, 不被 dedup/translate 覆盖. 比较 utt_clean.json 看 dedup 效果.",
    }
    raw_path.write_text(json.dumps(raw_data, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  [{tag}] raw OK, en={len(en)} -> {raw_path.name}")
    out = {"duration": r["metadata"].get("audio_duration"), "language": "en",
           "segments_en": en, "segments_zh": [],
           "_fetch_ts": time.time(), "_fetch_stage": "en-only",
           "job_id": job_id}
    zh_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  [{tag}] fetch OK (en-only), en={len(en)} dur={out['duration']}s")
    return True


def stage_dedup(tag):
    """Stage 3: 9 轮去重 en 段. 产物 utt_clean.json. 不动 gladia_raw.json.

    坑 AR 2026-07-06: race 期间 fetch 还没生成 gladia_zh.json 时, silent skip
    (而不是抛 FileNotFoundError). 下轮 fetch 完会自动走正常流程.

    坑 AX 2026-07-07: 旧版幂等检查比对 `len(zh.segments_en) == len(utt_clean)`,
    旧 gladia_zh.json (271 段) 跟旧 utt_clean.json (271 段) 对齐 → 永久跳过 dedup,
    永远跑不到新 dedup. 修复: 只看 utt_clean.json 存在 + 不空, 一律重跑 (dedup 自身
    不会写 0 段, 重跑开销 <1s).
    """
    d = WORK_ROOT / tag
    zh_path = d / "gladia_zh.json"
    uc_path = d / "utt_clean.json"
    if not zh_path.exists():
        # race: fetch 还没写盘, 下轮重试
        return
    # 强制重跑: dedup 输出要么不存在要么就用最新的, 不跟 zh.segments_en 段数比对
    # (那个数字是 fetch 阶段定的, 跟 dedup 无关)
    if uc_path.exists():
        try:
            existing = json.load(open(uc_path))
            if isinstance(existing, list) and len(existing) >= 0:
                # 留个备份方便回退, 强制重跑
                backup = uc_path.with_suffix('.json.pre_rededup')
                if not backup.exists():
                    uc_path.rename(backup)
                    log(f"  [{tag}] dedup redo: backed up old utt_clean.json -> .pre_rededup")
        except (json.JSONDecodeError, KeyError):
            pass
    rzp.stage_dedup(tag)


def stage_translate(tag):
    """Stage 4: DeepL en->zh. 产物: 回写 gladia_zh.json (en+zh)."""
    d = WORK_ROOT / tag
    zh_path = d / "gladia_zh.json"
    if zh_path.exists():
        try:
            existing = json.load(open(zh_path))
            en_n = len(existing.get("segments_en", []))
            zh_n = len(existing.get("segments_zh", []))
            if zh_n > 0 and zh_n == en_n:
                non_empty = sum(1 for s in existing["segments_zh"] if s.get("text", "").strip())
                if non_empty == en_n:
                    log(f"  [{tag}] skip translate, en+zh complete ({en_n}/{zh_n})")
                    return
        except (json.JSONDecodeError, KeyError):
            pass
    rzp.stage_translate(tag)


def stage_build(tag):
    srt_path = DOWNLOAD_DIR / f"{tag}.srt"
    zh_path = WORK_ROOT / tag / "gladia_zh.json"
    if srt_path.exists() and srt_path.stat().st_size > 1000:
        if srt_path.stat().st_mtime > zh_path.stat().st_mtime:
            log(f"  [{tag}] skip build, SRT exists and newer")
            return
    rzp.build_srt(tag)


def cmd_submit(args):
    """坑 AQ 2026-07-06: cmd_submit 入口一次性预检, 所有 tag 复用同一个 idx.

    之前每次 stage_submit 都调 find_working_key, 把已废的 key 重测 (3 key × N 期 = N² 量级).
    现在预检一次, 直到 mid-run 出现 AudioUrlKeyMismatch 才换 key.
    """
    tags = find_tags(args)
    if not tags:
        log("submit: no tag")
        return
    state = load_state()
    keys = g.load_keys()
    rotator = g.KeyRotator(keys)
    sync_state_with_disk(state, tags)
    log(f"active: {rotator.current_label()}")
    # 一次性预检, 跳过 state 里已废的 key
    prechecked = precheck_keys(rotator)
    if prechecked is None:
        log("submit: 所有 key 都废, 没法 submit")
        return
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("submitted", "fetched", "deduped", "translated", "built"):
            log(f"[{tag}] skip submit, already {stage}")
            continue
        try:
            job_id = stage_submit(rotator, tag, prechecked)
            set_stage(state, tag, "submitted", job_id=job_id)
        except Exception as e:
            log(f"[{tag}] submit FAIL: {e}")
            log(traceback.format_exc())
            set_stage(state, tag, "submit_failed", error=str(e))
            # 如果该 key 废了, 重新预检一次 (供下一 tag 用)
            if prechecked in rotator.bad:
                prechecked = precheck_keys(rotator)
                if prechecked is None:
                    log("submit: 预检 key 全部废, 停止 submit 剩下 tag")
                    return


def cmd_fetch(args):
    tags = find_tags(args)
    if not tags:
        log("fetch: no tag")
        return
    state = load_state()
    sync_state_with_disk(state, tags)
    keys = g.load_keys()
    key = keys[-1]
    log(f"using key ...{key[-8:]}")
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("fetched", "deduped", "translated", "built"):
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


def cmd_dedup(args):
    tags = find_tags(args)
    if not tags:
        log("dedup: no tag")
        return
    state = load_state()
    sync_state_with_disk(state, tags)
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("deduped", "translated", "built"):
            log(f"[{tag}] skip dedup, already {stage}")
            continue
        if stage not in ("fetched", "submitted"):
            log(f"[{tag}] skip dedup, stage={stage}")
            continue
        try:
            stage_dedup(tag)
            set_stage(state, tag, "deduped")
        except Exception as e:
            log(f"[{tag}] dedup FAIL: {e}")
            log(traceback.format_exc())


def cmd_translate(args):
    tags = find_tags(args)
    if not tags:
        log("translate: no tag")
        return
    state = load_state()
    sync_state_with_disk(state, tags)
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage in ("translated", "built"):
            log(f"[{tag}] skip translate, already {stage}")
            continue
        if stage not in ("deduped", "fetched"):
            log(f"[{tag}] skip translate, stage={stage}")
            continue
        try:
            stage_translate(tag)
            set_stage(state, tag, "translated")
        except Exception as e:
            log(f"[{tag}] translate FAIL: {e}")
            log(traceback.format_exc())


def cmd_build(args):
    tags = find_tags(args)
    if not tags:
        log("build: no tag")
        return
    state = load_state()
    sync_state_with_disk(state, tags)
    for tag in tags:
        stage, data = get_stage(state, tag)
        if stage == "built":
            log(f"[{tag}] skip build, already built")
            continue
        if stage not in ("translated", "deduped", "fetched"):
            log(f"[{tag}] skip build, stage={stage}")
            continue
        try:
            stage_build(tag)
            set_stage(state, tag, "built")
        except Exception as e:
            log(f"[{tag}] build FAIL: {e}")
            log(traceback.format_exc())


def cmd_status(args):
    """坑 AP 2026-07-05: one TAG 模式只打印 TAG, 不打印 state.json 全集.

    有 args 走 args (one TAG 时只看这个 TAG); 无 args 看全部 state.
    """
    state = load_state()
    tags = args if args else sorted(state.keys())
    for tag in tags:
        if tag not in state:
            log(f"  [{tag}] (no state)")
            continue
        stage = state[tag].get("stage")
        job_id = state[tag].get("job_id", "-")[:20]
        srt = DOWNLOAD_DIR / f"{tag}.srt"
        srt_info = f" SRT={srt.stat().st_size}B" if srt.exists() else ""
        log(f"  [{tag}] {stage:14s} job_id={job_id}{srt_info}")


def write_result_log(tags):
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
            status_line = "fetched (en-only) but not deduped"
        elif stage == "deduped":
            status_line = "deduped but not translated"
        elif stage == "translated":
            status_line = "translated but not built"
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


def main():
    if len(sys.argv) < 2:
        print("usage: run_all_win.py {submit|fetch|dedup|translate|build|status|auto|one} [tags...]", file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "submit":
        cmd_submit(args)
    elif cmd == "fetch":
        cmd_fetch(args)
    elif cmd == "dedup":
        cmd_dedup(args)
    elif cmd == "translate":
        cmd_translate(args)
    elif cmd == "build":
        cmd_build(args)
    elif cmd == "status":
        cmd_status(args)
    elif cmd == "auto":
        import argparse
        ap = argparse.ArgumentParser(add_help=False)
        ap.add_argument("--max-secs", type=int, default=3600)
        ap.add_argument("--sleep", type=int, default=20)
        ap.add_argument("tags", nargs="*")
        opts, leftover = ap.parse_known_args(args)
        tags = find_tags(opts.tags)
        deadline = time.time() + opts.max_secs
        log(f"=== auto: {len(tags)} tag(s), max={opts.max_secs}s, sleep={opts.sleep}s ===")
        round_n = 0
        while time.time() < deadline:
            round_n += 1
            log(f"--- auto round {round_n} ---")
            cmd_submit(tags)
            cmd_fetch(tags)
            cmd_dedup(tags)
            cmd_translate(tags)
            cmd_build(tags)
            cmd_status(tags)
            state = load_state()
            all_built = all(
                state.get(t, {}).get("stage") == "built"
                for t in tags
            )
            if all_built:
                log("=== all built, exit auto ===")
                write_result_log(tags)
                return
            time.sleep(opts.sleep)
        log("=== auto timeout ===")
        write_result_log(tags)
    elif cmd == "one":
        import argparse
        ap = argparse.ArgumentParser(add_help=False)
        ap.add_argument("--max-secs", type=int, default=3600)
        ap.add_argument("tags", nargs="*")
        opts, leftover = ap.parse_known_args(args)
        tags = find_tags(opts.tags)
        log(f"=== one: {len(tags)} tag(s) ===")
        for tag in tags:
            log(f"--- tag {tag} ---")
            state = load_state()
            sync_state_with_disk(state, tags)
            stage, data = get_stage(state, tag)
            if stage != "built":
                cmd_submit([tag])
                cmd_fetch([tag])
                cmd_dedup([tag])
                cmd_translate([tag])
                cmd_build([tag])
        write_result_log(tags)
    else:
        print(f"unknown cmd: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
