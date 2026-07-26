#!/usr/bin/env python3
"""Gladia REST API v2 转录脚本 - 多 key 轮询 + 预检 + 可断点续跑.

key 来源 (优先级):
1. 环境变量 GLADIA_API_KEY
2. 同目录 keys 文件 (一行一个, # 开头为注释)

续跑机制:
  - submit 后把 job_id 写到 <OUT>.job_id 文件
  - bash 超时被砍, 下次重跑 --resume <job_id> 直接进入 polling
  - poll 中途超时也支持 (会用新 key 续轮询同一个 job_id)

=== Gladia v2 API 优化点 (2026-07-01 查官方文档后) ===
[官方文档] https://docs.gladia.io/api-reference/v2/pre-recorded/init
[官方推荐] https://docs.gladia.io/chapters/pre-recorded-stt/recommended-parameters
- subtitles_config.maximum_characters_per_row=42 (broadcast limit)
- subtitles_config.maximum_rows_per_caption=2
- subtitles_config.style="compliance" (公开刊物风格)
- language_config.languages=["en"] + code_switching=false (单语时强制显式)
- sentences: true (语义分句, 让 SRT 段更可读)
- 2026-07-05: 关闭 summarization/chapterization (额外消耗 transcription 池)
- 2026-07-05: 不传 translation_config (translation 池是单独计费, en-only 流水线不让它跑)

=== 2026-07-06 改: key 预检去重 ===
- 启动时一次性 find_working_key (bad_keys 跳过)
- mid-run quota/auth 失败 -> mark_bad(idx), 下次 find_working_key 直接跳过
- 上传时直接 use(stored_idx), 不再每次扫描
"""
import os
import sys
import json
import time
import mimetypes
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent


class KeyRotatorExhausted(Exception):
    """rotator 走完所有 key 后抛出, 区别于 sys.exit(3) 的静默退出."""
    pass


class AudioUrlKeyMismatch(Exception):
    """audio_url 跟当前 key 不匹配, 必须重新 upload."""
    pass


def load_keys():
    keys = []
    env = os.environ.get("GLADIA_API_KEY")
    if env:
        keys.append(env)
    keys_file = SCRIPT_DIR / "keys"
    if keys_file.exists():
        for line in keys_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line not in keys:
                keys.append(line)
    if not keys:
        print("ERROR: no key. set GLADIA_API_KEY env or add to keys file.", file=sys.stderr)
        sys.exit(2)
    print(f"loaded {len(keys)} key(s)", flush=True)
    return keys


class KeyRotator:
    def __init__(self, keys):
        self.keys = keys
        self.idx = 0
        self.current = keys[0]
        # 已知不可用的 key idx 集合 (mid-run quota/auth 失败时填)
        self.bad = set()

    def current_label(self):
        return f"key#{self.idx+1}/{len(self.keys)} ({self.current[:8]}...)"

    def rotate(self, reason=""):
        # 跳过所有已知 bad 的 key
        for _ in range(len(self.keys)):
            next_idx = self.idx + 1
            if next_idx >= len(self.keys):
                next_idx = 0
            if next_idx in self.bad:
                self.idx = next_idx
                continue
            self.idx = next_idx
            self.current = self.keys[self.idx]
            print(f"rotate -> {self.current_label()} ({reason})", flush=True)
            return
        raise KeyRotatorExhausted(
            f"all {len(self.keys)} key(s) exhausted. last reason: {reason}"
        )

    def use(self, idx):
        """直接切到指定 idx (预检用)."""
        if idx in self.bad:
            raise ValueError(f"key#{idx+1} already marked bad")
        self.idx = idx
        self.current = self.keys[idx]

    def mark_bad(self, idx=None, reason=""):
        """标记某个 key 不可用. 默认标记当前 key. 之后 find_working_key 会跳过."""
        if idx is None:
            idx = self.idx
        if idx not in self.bad:
            self.bad.add(idx)
            print(f"  [mark_bad] key#{idx+1}/{len(self.keys)} ...{self.keys[idx][-8:]} ({reason})", flush=True)


def test_key(rotator):
    """用占位 audio_url 测当前 key. 返回 'ok' | 'quota' | 'auth' | 'unknown'.

    区分:
      'ok'      -> auth OK + quota OK (audio fetch fail 是 400 因为 URL 是假的)
      'quota'   -> 402 quota exhausted
      'auth'    -> 401/403 key 无效
      'unknown' -> 其它 (网络错误 / 不明 4xx)
    """
    config = {
        "audio_url": "https://gladia.io/sample-audio.mp3",
        "language_config": {"languages": ["en"], "code_switching": False},
        "diarization": True,
        "sentences": True,
    }
    try:
        h = {"x-gladia-key": rotator.current, "Content-Type": "application/json"}
        body = json.dumps(config).encode()
        req = urllib.request.Request(EP_INIT, data=body, method="POST", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return "ok"
        except urllib.error.HTTPError as e:
            data = e.read().decode("utf-8", "replace")
            if e.code == 400:
                msg = data.lower()
                if "fetch audio" in msg or "failed to fetch" in msg:
                    return "ok"
                return "unknown"
            if e.code == 401 or e.code == 403:
                return "auth"
            if e.code == 402 or e.code == 429:
                return "quota"
            return "unknown"
    except Exception as e:
        print(f"  [test_key] exception: {e}", flush=True)
        return "unknown"


def find_working_key(rotator, force=False):
    """循环所有 key 用 test_key 找第一个 ok. 跳过已知 bad. 找不到返回 None, 不动 rotator idx.

    坑 AQ 2026-07-06: fast-path — 如果 rotator 当前 idx 没在 bad 里, 直接返回,
    省去对已知好 key 的重复 test_key (每个 tag 都重测 = N 倍浪费).
    force=True: 跳过 fast-path, 强制从头扫描 (启动预检用, 因为 rotator 默认 idx=0 不一定活).
    """
    n = len(rotator.keys)
    # fast-path: 当前 idx 已知好, 直接返回 (避免重复探测)
    if not force and rotator.idx not in rotator.bad and rotator.idx < n:
        print(f"  [find_key] fast-path: 当前 key#{rotator.idx+1}/{n} 未标 bad, 复用", flush=True)
        return rotator.idx
    for i in range(n):
        if i in rotator.bad:
            print(f"  [find_key] skip key#{i+1}/{n} (already marked bad)", flush=True)
            continue
        rotator.use(i)
        print(f"  [find_key] testing key#{i+1}/{n} ...{rotator.current[-8:]}...", flush=True)
        r = test_key(rotator)
        print(f"    -> {r}", flush=True)
        if r == "ok":
            return i
        # 测出来坏的也加进 bad, 下次 skip
        if r in ("quota", "auth"):
            rotator.mark_bad(i, reason=f"test_key={r}")
    return None


# ===== 命令行参数 =====
SRC = None
OUT = None
RESUME = None
MAX_ITERS = 60
INTERVAL = 5

_args = sys.argv[1:]
while _args:
    a = _args.pop(0)
    if a == "--resume":
        RESUME = _args.pop(0)
    elif a == "--max-iters":
        MAX_ITERS = int(_args.pop(0))
    elif a == "--interval":
        INTERVAL = int(_args.pop(0))
    elif SRC is None:
        SRC = Path(a)
    elif OUT is None:
        OUT = Path(a)

if SRC is None:
    SRC = SCRIPT_DIR.parent.parent / "uploads" / "Naked_News-2025.08.14_audio.m4a"
if OUT is None:
    OUT = SCRIPT_DIR / "gladia_segments.json"

# 端点路径 (官方 v2, deprecated 改走 /v2/transcription/)
BASE = "https://api.gladia.io/v2"
EP_UPLOAD = f"{BASE}/upload"
EP_INIT = f"{BASE}/pre-recorded"
EP_GET = f"{BASE}/pre-recorded"  # 用 f"{BASE}/pre-recorded/{id}"

# 官方推荐参数 (podcast 长音频, 单英语)
LANGUAGES = ["en"]
SPEAKERS_MIN = 2
SPEAKERS_MAX = 5
SUBTITLE_MAX_CHARS = 42
SUBTITLE_MAX_ROWS = 2
SENTENCES = True
POLL_INTERVAL = INTERVAL
POLL_MAX_ITERS = MAX_ITERS


def is_key_problem(status, data):
    """判定 status 是否需要 rotate (quota/rate limit vs key 错)."""
    if status == 401 or status == 403:
        return False
    if status == 402 or status == 429:
        return True
    if status < 400:
        return False
    if isinstance(data, (str, dict)):
        msg = json.dumps(data).lower() if isinstance(data, dict) else data.lower()
        if any(k in msg for k in ("quota", "rate limit", "unauthorized", "invalid api key",
                                  "no gladia key", "10h of free", "upgrade your plan",
                                  "free audio transcription")):
            return True
    return False


def http_post_json(rotator, url, payload, timeout=60):
    h = {"x-gladia-key": rotator.current, "Content-Type": "application/json"}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers=h)
    return _do_request(req, timeout)


def http_get(rotator, url, timeout=30):
    h = {"x-gladia-key": rotator.current}
    req = urllib.request.Request(url, method="GET", headers=h)
    return _do_request(req, timeout)


def _do_request(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def upload(rotator, src=None):
    src = src or SRC
    print(f"[1/3] uploading (multipart) {src.name}...", flush=True)
    boundary = "----gladia-boundary-xyz123"
    filename = src.name
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(src, "rb") as f:
        body = f.read()
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        body,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    multipart_body = b"".join(parts)
    h = {
        "x-gladia-key": rotator.current,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    req = urllib.request.Request(EP_UPLOAD, data=multipart_body, method="POST", headers=h)
    status, data = _do_request(req, 180)
    print("upload status:", status, flush=True)
    if status >= 300:
        print("UPLOAD ERROR:", data, file=sys.stderr)
        sys.exit(1)
    return data["audio_url"]


def transcribe_with_audio_url(rotator, audio_url):
    """POST /v2/pre-recorded 提交 audio_url. 返回 (status, data), 不内部 rotate.

    2026-07-05 改: 纯 en transcription 调用, 关闭所有消耗额外 quota 的开关:
    - 不传 translation_config: translation 池单独计费, en-only 流水线不需要
    - summarization=False, chapterization=False: 这俩也是 transcription 池消耗
    - 只保留 en stt + diarization + sentences + subtitles
    """
    print("[2/3] transcribing (en-only)...", flush=True)
    config = {
        "audio_url": audio_url,
        "language_config": {"languages": LANGUAGES, "code_switching": False},
        "diarization": True,
        "diarization_config": {"min_speakers": SPEAKERS_MIN, "max_speakers": SPEAKERS_MAX},
        "sentences": SENTENCES,
        "subtitles": True,
        "subtitles_config": {
            "formats": ["srt"],
            "maximum_characters_per_row": SUBTITLE_MAX_CHARS,
            "maximum_rows_per_caption": SUBTITLE_MAX_ROWS,
            "style": "compliance",
        },
        # 关闭所有 LLM 额外输出, 只跑最便宜的 en transcription 池
        "summarization": False,
        "chapterization": False,
        "sentiment_analysis": False,
        # 不传 translation_config (zh 翻译让 DeepL 做)
    }
    return http_post_json(rotator, EP_INIT, config, timeout=60)


def transcribe(rotator, audio_url):
    """submit audio_url + 配对处理.

    规则 (坑 AL 2026-07-05): Gladia audio_url 跟 uploader key 绑定.
    - 401/403: 当前 key 没权 fetch 那个 audio_url, audio_url 废了, raise AudioUrlKeyMismatch.
    - 402/429: quota/rate, 让 caller 整个重来.
    """
    status, data = transcribe_with_audio_url(rotator, audio_url)
    print("submit status:", status, flush=True)
    if status == 401 or status == 403:
        raise AudioUrlKeyMismatch(f"submit auth FAIL (audio_url 跟 key 不匹配): {status} {data}")
    if is_key_problem(status, data):
        raise AudioUrlKeyMismatch(f"submit quota/rate: {status} {data} - 需重新 upload 用新 key")
    if status >= 300:
        raise RuntimeError(f"submit fail: {status} {data}")
    return data["id"]


def poll(rotator, job_id):
    """poll /v2/pre-recorded/{id}. 401/403 切 key (不同 key 可能能读别人提交), quota 切 key."""
    print("[3/3] polling...", flush=True)
    for i in range(POLL_MAX_ITERS):
        time.sleep(POLL_INTERVAL)
        status, data = http_get(rotator, f"{EP_GET}/{job_id}", timeout=30)
        if is_key_problem(status, data):
            rotator.mark_bad(reason=f"poll quota/rate status={status}")
            try:
                rotator.rotate(f"status={status}")
            except KeyRotatorExhausted:
                print(f"POLL: all keys exhausted, can't read job {job_id}", file=sys.stderr)
                raise
            return poll(rotator, job_id)
        if status == 401 or status == 403:
            try:
                rotator.rotate(f"status={status}, trying next key")
            except KeyRotatorExhausted:
                print(f"POLL: all keys unauthorized for {job_id}", file=sys.stderr)
                raise
            return poll(rotator, job_id)
        s = data.get("status") if isinstance(data, dict) else None
        print(f"  poll {i}: {s}", flush=True)
        if s == "done":
            return data["result"]
        if s == "error":
            print("TRANSCRIPTION ERROR:", data, file=sys.stderr)
            sys.exit(1)
    print(f"TIMEOUT after {POLL_MAX_ITERS} iters (resume later)", file=sys.stderr, flush=True)
    return None


def normalize(result):
    out = []
    utterances = result.get("transcription", {}).get("utterances", [])
    if utterances:
        for utt in utterances:
            out.append({
                "start": round(utt["start"], 2),
                "end": round(utt["end"], 2),
                "speaker": utt.get("speaker"),
                "text": utt["text"].strip(),
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


if __name__ == "__main__":
    print(f"using {SRC}", flush=True)
    print(f"output {OUT}", flush=True)
    print(f"max_iters={POLL_MAX_ITERS} interval={POLL_INTERVAL}s", flush=True)
    print(f"endpoint={EP_INIT}  LANGUAGES={LANGUAGES}", flush=True)

    keys = load_keys()
    rotator = KeyRotator(keys)
    print(f"active: {rotator.current_label()}", flush=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    job_id_file = OUT.parent / (OUT.stem + ".job_id")

    if RESUME:
        job_id = RESUME
        print(f"[resume] using job_id={job_id}", flush=True)
    elif job_id_file.exists():
        job_id = job_id_file.read_text().strip()
        print(f"[resume-auto] found {job_id_file.name} -> job_id={job_id}", flush=True)
    else:
        # 0) 预检: 找第一个 test_key=ok 的 key 来上传 (2026-07-05)
        idx = find_working_key(rotator)
        if idx is None:
            print("ERROR: 所有 key 都不工作 (quota 爆 或 auth 错), 没法 submit", file=sys.stderr)
            sys.exit(2)
        rotator.use(idx)
        print(f"[pre-check] 选 key#{idx+1}/{len(rotator.keys)} ...{rotator.current[-8:]}", flush=True)

        audio_url = upload(rotator)
        job_id = transcribe(rotator, audio_url)
        job_id_file.write_text(job_id)
        print(f"[persist] job_id -> {job_id_file}", flush=True)

    result = poll(rotator, job_id)
    if result is None:
        print(f"poll timed out, job_id persisted at {job_id_file}", flush=True)
        print(f"resume later: python3 gladia.py <SRC> <OUT> --resume {job_id}", flush=True)
        sys.exit(4)

    segments = normalize(result)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "duration": result.get("metadata", {}).get("audio_duration") or result.get("metadata", {}).get("duration"),
            "language": LANGUAGES[0],
            "segments": segments,
            "summary": result.get("summarization", {}).get("results") if "summarization" in result else None,
            "chapters": result.get("chapterization", {}).get("results") if "chapterization" in result else None,
            "subtitles_srt": (result.get("subtitles") or [{}])[0].get("subtitles") if isinstance(result.get("subtitles"), list) and result.get("subtitles") else None,
            "translation_zh": _extract_zh_translation(result),
        }, f, ensure_ascii=False, indent=2)
    print(f"OK -> {OUT}, {len(segments)} utterances", flush=True)


def _extract_zh_translation(result):
    """如果以后打开 translation=true, 把中文翻译也带回来 (本版本默认不开, 占位)."""
    t = result.get("translation")
    if not t or not t.get("results"):
        return None
    out = []
    for r in t["results"]:
        if isinstance(r, dict) and "text" in r:
            out.append({"text": r["text"], "language": r.get("language") or r.get("target_language") or "zh"})
    return out or None
