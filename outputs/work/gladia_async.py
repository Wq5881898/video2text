#!/usr/bin/env python3
"""Gladia 异步转写 - 拆成多个 bash tick。
用法:
  python3 gladia_async.py submit <SRC.m4a> <WORK_DIR>
  python3 gladia_async.py poll <WORK_DIR>

Key 解析顺序:
  1. 环境变量 GLADIA_API_KEY
  2. /outputs/work/.gladia_keys 文件（一行一个，按顺序轮换）
所有 key 都用完才抛异常。
"""
import os, sys, json, time
import urllib.request, urllib.error

KEYS_FILE = "/sessions/zealous-upbeat-ritchie/mnt/outputs/work/.gladia_keys"


def load_keys():
    """返回可用 key 列表（先去重去空）"""
    keys = []
    env = os.environ.get("GLADIA_API_KEY")
    if env:
        keys.append(env)
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE) as f:
            for line in f:
                k = line.strip()
                if k and k not in keys:
                    keys.append(k)
    return keys


if len(sys.argv) < 3:
    sys.exit("usage: gladia_async.py <submit|poll> <SRC_OR_WORK_DIR> [WORK_DIR]")

UA = "Mozilla/5.0"


def _upload(api_key, audio):
    """上传，返回 audio_url 或抛 HTTPError"""
    boundary = "----gladia" + os.urandom(8).hex()
    parts = [
        f"--{boundary}".encode(),
        b'Content-Disposition: form-data; name="audio"; filename="audio.m4a"',
        b"Content-Type: audio/mp4",
        b"", audio,
        f"--{boundary}--".encode(), b"",
    ]
    body = b"\r\n".join(parts)
    h = {"x-gladia-key": api_key, "User-Agent": UA,
         "Content-Type": f"multipart/form-data; boundary={boundary}"}
    req = urllib.request.Request("https://api.gladia.io/v2/upload/",
                                 data=body, method="POST", headers=h)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())["audio_url"]


def _start_job(api_key, audio_url):
    """提交转写任务，返回 job_id"""
    cfg = {
        "audio_url": audio_url,
        "language_config": {"languages": ["en"]},
        "diarization": True,
        "diarization_config": {"min_speakers": 2, "max_speakers": 5},
        "subtitles": True,
        "subtitles_config": {"formats": ["srt"]},
        "summarization": True,
        "summarization_config": {"type": "general"},
        "chapterization": True,
    }
    h = {"x-gladia-key": api_key, "User-Agent": UA, "Content-Type": "application/json"}
    req = urllib.request.Request("https://api.gladia.io/v2/transcription/",
                                  data=json.dumps(cfg).encode(), method="POST", headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["id"]


def _check_status(api_key, job_id):
    """检查任务状态，返回 ('done'|'processing'|'error', data)"""
    h = {"x-gladia-key": api_key, "User-Agent": UA}
    req = urllib.request.Request(f"https://api.gladia.io/v2/transcription/{job_id}",
                                 method="GET", headers=h)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return data.get("status"), data


def submit():
    src = sys.argv[2]
    work = sys.argv[3]
    os.makedirs(work, exist_ok=True)
    job_file = f"{work}/gladia_job.json"
    print(f"[submit] src: {src}", flush=True)
    print(f"[submit] work: {work}", flush=True)

    keys = load_keys()
    if not keys:
        sys.exit("no GLADIA_API_KEY env and no .gladia_keys file")
    print(f"[submit] loaded {len(keys)} key(s)", flush=True)

    with open(src, "rb") as f:
        audio = f.read()
    print(f"[submit] uploading {len(audio)} bytes...", flush=True)

    last_err = None
    for i, key in enumerate(keys):
        try:
            print(f"[submit] trying key #{i+1} ({key[:8]}...)", flush=True)
            audio_url = _upload(key, audio)
            print(f"[submit] uploaded -> {audio_url[:80]}...", flush=True)
            job_id = _start_job(key, audio_url)
            with open(job_file, "w") as f:
                json.dump({"id": job_id, "submitted_at": time.time(),
                           "key_index": i}, f)
            print(f"[submit] job id: {job_id} (key #{i+1})", flush=True)
            return
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            print(f"[submit] key #{i+1} failed: HTTP {e.code} {body[:200]}", flush=True)
            last_err = e
            if e.code in (401, 403, 429):
                # key 无效/超限/被限流，尝试下一个
                continue
            else:
                sys.exit(f"UPLOAD FAIL: HTTP {e.code} {body}")
        except Exception as e:
            print(f"[submit] key #{i+1} error: {e}", flush=True)
            last_err = e
            continue

    sys.exit(f"all {len(keys)} key(s) exhausted. last error: {last_err}")


def poll():
    work = sys.argv[2]
    job_file = f"{work}/gladia_job.json"
    raw_file = f"{work}/gladia_raw.json"
    if not os.path.exists(job_file):
        sys.exit(f"no job file: {job_file}, run submit first")
    job = json.load(open(job_file))
    job_id = job["id"]
    key_index = job.get("key_index", 0)

    keys = load_keys()
    if not keys:
        sys.exit("no GLADIA_API_KEY env and no .gladia_keys file")
    if key_index >= len(keys):
        sys.exit(f"recorded key_index {key_index} >= {len(keys)} keys available")
    api_key = keys[key_index]
    print(f"[poll] using key #{key_index+1}", flush=True)

    status, data = _check_status(api_key, job_id)
    print(f"[poll] {status}", flush=True)
    if status == "done":
        with open(raw_file, "w") as f:
            json.dump(data["result"], f, ensure_ascii=False, indent=2, default=str)
        print(f"[poll] DONE -> {raw_file}", flush=True)
        return
    if status == "error":
        print("ERROR", data, file=sys.stderr); sys.exit(1)
    # not done yet
    sys.exit(2)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "submit": submit()
    elif cmd == "poll": poll()
    else: sys.exit(f"unknown cmd: {cmd}")
