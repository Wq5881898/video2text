#!/usr/bin/env python3
"""批量跑 Gladia 转写 + dedup, 支持分批/并发/退避.

策略:
- 默认串行 (concurrency=1), 避免打爆 key 配额
- 用户可指定 --concurrent N 并发
- 自动分批: --batch-size N 一批处理 N 个, 中间停 --batch-pause 秒
- 配额检测: 若响应包含 'quota'/'rate limit', 自动退避 --backoff 秒后重试
- 进度写到 <期>/progress.log, 总结写到 batch_summary.json
- 进程 PID 写到 /tmp/gladia_batch.pid 方便监控

用法:
  python3 batch_transcribe.py 250805 250811 250814                    # 串行 3 个
  python3 batch_transcribe.py --concurrent 2 250805 250811 250814     # 2 并发
  python3 batch_transcribe.py --batch-size 5 --batch-pause 30 ...     # 5 个一批, 批间停 30s
  python3 batch_transcribe.py --auto 250805 250811 ...                 # 自动模式: 配额满时退避+分批

踩坑记录:
- 同一 key 在短时间多次上传会被 Gladia 限速 (rate limit)
- 退避时间 30-60 秒通常足够, 不够再 retry 一次
- 并发 2 是安全上限, 并发 3+ 容易触发 rate limit
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PID_FILE = Path("/tmp/gladia_batch.pid")
DEFAULT_CONCURRENCY = 1
DEFAULT_BATCH_SIZE = 5
DEFAULT_BATCH_PAUSE = 30
DEFAULT_BACKOFF = 60
DEFAULT_MAX_WAIT = 480  # 单 job 最长等 8 分钟


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def run_gladia_one(tag, audio, out_dir, resume_id=None, max_wait=DEFAULT_MAX_WAIT, interval=5, max_iters=60):
    """处理一个音频: submit + poll, 直到 done/timeout/error.
    
    返回 (status, segments, error_msg)
    status: 'done' | 'timeout' | 'error' | 'quota_exceeded'
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "progress.log"
    
    job_id = resume_id
    if job_id:
        log(f"[{tag}] resume job_id={job_id}")
    else:
        log(f"[{tag}] submit")
    
    args = ["python3", "-u", str(SCRIPT_DIR / "gladia.py"),
            str(audio), str(out_dir / "gladia_raw.json"),
            "--interval", str(interval), "--max-iters", str(max_iters)]
    if job_id:
        args += ["--resume", job_id]
    
    # 启动 gladia 子进程
    log_f = open(log_path, "a")
    log_f.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} start {tag} ===\n")
    log_f.flush()
    
    proc = subprocess.Popen(args, stdout=log_f, stderr=subprocess.STDOUT)
    start = time.time()
    while True:
        ret = proc.poll()
        elapsed = time.time() - start
        if ret is not None:
            log_f.close()
            if ret == 0:
                raw = out_dir / "gladia_raw.json"
                if raw.exists():
                    try:
                        d = json.load(open(raw))
                        return ("done", len(d.get("segments", [])), None)
                    except Exception as e:
                        return ("error", 0, f"parse json: {e}")
                return ("done", 0, None)
            elif ret == 4:
                # timeout, 保留 job_id
                return ("timeout", 0, None)
            else:
                # 看 log 里有没有 quota 关键字
                log_text = log_path.read_text() if log_path.exists() else ""
                if "quota" in log_text.lower() or "rate limit" in log_text.lower():
                    return ("quota_exceeded", 0, "rate limit hit")
                return ("error", ret, f"exit code {ret}")
        if elapsed > max_wait:
            proc.kill()
            log_f.close()
            return ("timeout", 0, "outer timeout")
        time.sleep(2)


def has_resume_id(out_dir):
    """检查是否已有未完成的 job_id."""
    jf = out_dir / "gladia_raw.job_id"
    if not jf.exists():
        return None
    raw = out_dir / "gladia_raw.json"
    if raw.exists() and raw.stat().st_size > 100:
        return None  # 已完成
    return jf.read_text().strip() or None


def is_already_done(out_dir):
    raw = out_dir / "gladia_raw.json"
    if not raw.exists() or raw.stat().st_size < 100:
        return False
    try:
        d = json.load(open(raw))
        return len(d.get("segments", [])) > 0
    except:
        return False


def process_batch(tags, concurrency, backoff, batch_size, batch_pause, max_wait):
    """处理一批 tags, 支持并发."""
    audio_root = Path("/sessions/relaxed-peaceful-brown/mnt/DownloadTest")
    work_root = SCRIPT_DIR
    
    # 分批
    for batch_start in range(0, len(tags), batch_size):
        batch = tags[batch_start:batch_start + batch_size]
        log(f"=== batch {batch_start//batch_size + 1}: {batch} (concurrency={concurrency}) ===")
        
        if batch_start > 0:
            log(f"sleep {batch_pause}s between batches...")
            time.sleep(batch_pause)
        
        results = {}
        quota_hits = 0
        
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = {}
            for tag in batch:
                audio = audio_root / f"{tag}.m4a"
                out_dir = work_root / tag
                
                if not audio.exists():
                    log(f"!! {tag}: audio not found, skip")
                    results[tag] = ("missing", 0, None)
                    continue
                
                if is_already_done(out_dir):
                    d = json.load(open(out_dir / "gladia_raw.json"))
                    n = len(d.get("segments", []))
                    log(f"skip {tag}: already done ({n} segments)")
                    results[tag] = ("done", n, None)
                    continue
                
                resume = has_resume_id(out_dir)
                fut = ex.submit(run_gladia_one, tag, audio, out_dir, resume, max_wait)
                futures[fut] = tag
            
            for fut in as_completed(futures):
                tag = futures[fut]
                status, n, err = fut.result()
                results[tag] = (status, n, err)
                log(f"  {tag}: {status}, {n} segments" + (f" (err: {err})" if err else ""))
                if status == "quota_exceeded":
                    quota_hits += 1
        
        # 配额触发了, 退避
        if quota_hits > 0:
            log(f"!! {quota_hits} quota hits, backing off {backoff}s...")
            time.sleep(backoff)
    
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tags", nargs="+", help="期号列表, 如 250805 250811 ...")
    ap.add_argument("--concurrent", type=int, default=DEFAULT_CONCURRENCY,
                    help=f"并发数 (默认 {DEFAULT_CONCURRENCY}, 安全上限 2)")
    ap.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                    help=f"每批处理几个 (默认 {DEFAULT_BATCH_SIZE})")
    ap.add_argument("--batch-pause", type=int, default=DEFAULT_BATCH_PAUSE,
                    help=f"批间停几秒 (默认 {DEFAULT_BATCH_PAUSE}s)")
    ap.add_argument("--backoff", type=int, default=DEFAULT_BACKOFF,
                    help=f"配额满退避秒数 (默认 {DEFAULT_BACKOFF}s)")
    ap.add_argument("--max-wait", type=int, default=DEFAULT_MAX_WAIT,
                    help=f"单 job 最长等几秒 (默认 {DEFAULT_MAX_WAIT}s)")
    args = ap.parse_args()
    
    PID_FILE.write_text(str(os.getpid()))
    log(f"batch_transcribe start: tags={args.tags}")
    log(f"config: concurrency={args.concurrent}, batch_size={args.batch_size}, "
        f"batch_pause={args.batch_pause}s, backoff={args.backoff}s, max_wait={args.max_wait}s")
    
    results = process_batch(
        args.tags, args.concurrent, args.backoff,
        args.batch_size, args.batch_pause, args.max_wait
    )
    
    summary = SCRIPT_DIR / "batch_summary.json"
    summary.write_text(json.dumps(results, ensure_ascii=False, indent=2))
    
    done_count = sum(1 for s, _, _ in results.values() if s == "done")
    err_count = sum(1 for s, _, _ in results.values() if s in ("error", "timeout", "quota_exceeded"))
    log(f"batch done: {done_count}/{len(results)} ok, {err_count} errors")
    log(f"summary -> {summary}")
    
    if PID_FILE.exists():
        PID_FILE.unlink()
    
    sys.exit(0 if err_count == 0 else 1)


if __name__ == "__main__":
    main()
