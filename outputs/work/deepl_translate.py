#!/usr/bin/env python3
"""deepl_translate.py - DeepL Free en->zh 翻译驱动.

输入: utt_clean.json (去重后英文段数组)
输出: 调用 DeepL Free API 翻译, 合并 en+zh 写到 gladia_zh.json

key 来源 (优先级):
1. 环境变量 DEEPL_KEY
2. 同目录 deeplkey.txt (单行, 无前后空格)

配额: 50万字符/月 (DeepL Free), 不超额 (456 错误)
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

RUNTIME_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
SCRIPT_DIR = RUNTIME_ROOT / "outputs" / "work" if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_DIR = RUNTIME_ROOT / "config" if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent.parent / "config"

# 翻译端点 (免费层用 api-free.deepl.com, 不是 api.deepl.com)
DEEPL_URL = "https://api-free.deepl.com/v2/translate"
SOURCE_LANG = "EN"
TARGET_LANG = "ZH"
BATCH_SIZE = 50  # 一次最多 50 句, 防单次请求过大
BATCH_PAUSE = 0.5  # 批量间 sleep, 防限速
MAX_CHARS_PER_REQ = 50000  # DeepL 单请求 50k 字符硬限
MAX_RETRIES = 3
RETRY_PAUSE = 5


def load_key():
    """从环境变量或 config/deepl_key.txt 读 key."""
    k = os.environ.get("DEEPL_KEY", "").strip()
    if k:
        return k
    p = CONFIG_DIR / "deepl_key.txt"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    raise FileNotFoundError(
        "DeepL key not found. Set DEEPL_KEY env var or create config/deepl_key.txt"
    )


def translate_batch(key, texts):
    """一次提交一批, 失败重试.

    返回: list[str] (跟 input 同序)
    """
    if not texts:
        return []
    data_parts = []
    for t in texts:
        # DeepL text 参数 URL-encode 后塞 body
        from urllib.parse import quote
        data_parts.append(f"text={quote(t, safe='')}")
    data_parts.append(f"source_lang={SOURCE_LANG}")
    data_parts.append(f"target_lang={TARGET_LANG}")
    body = "&".join(data_parts).encode("utf-8")

    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(
                DEEPL_URL, data=body,
                headers={"Authorization": "DeepL-Auth-Key " + key,
                         "Content-Type": "application/x-www-form-urlencoded"}
            )
            resp = urllib.request.urlopen(req, timeout=30)
            payload = json.loads(resp.read())
            translations = payload.get("translations", [])
            if len(translations) != len(texts):
                raise RuntimeError(
                    f"DeepL returned {len(translations)} translations for {len(texts)} texts"
                )
            return [t["text"] for t in translations]
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            err = f"HTTP {e.code}: {body[:200]}"
            last_err = err
            # 456 = quota exceeded, 不重试
            if e.code == 456:
                raise RuntimeError(f"DeepL quota exceeded (456): {body[:200]}")
            # 403 = invalid key
            if e.code == 403:
                raise RuntimeError(f"DeepL auth failed (403): {body[:200]}")
            # 429 = rate limit, 等久点
            if e.code == 429:
                wait = RETRY_PAUSE * (attempt + 1) * 2
                print(f"  [deepl] 429 rate limit, sleep {wait}s (attempt {attempt+1})", flush=True)
                time.sleep(wait)
                continue
            # 其他错误短暂重试
            if attempt < MAX_RETRIES - 1:
                print(f"  [deepl] {err}, retry in {RETRY_PAUSE}s (attempt {attempt+1})", flush=True)
                time.sleep(RETRY_PAUSE)
            continue
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < MAX_RETRIES - 1:
                print(f"  [deepl] {last_err}, retry in {RETRY_PAUSE}s", flush=True)
                time.sleep(RETRY_PAUSE)
            continue
    raise RuntimeError(f"DeepL translate failed after {MAX_RETRIES} retries: {last_err}")


def chunk_by_chars(texts, max_chars=MAX_CHARS_PER_REQ):
    """按字符数切片, 防止单请求超 50k 字符."""
    batches = []
    cur = []
    cur_chars = 0
    for t in texts:
        tlen = len(t)
        if cur and (cur_chars + tlen > max_chars or len(cur) >= BATCH_SIZE):
            batches.append(cur)
            cur = [t]
            cur_chars = tlen
        else:
            cur.append(t)
            cur_chars += tlen
    if cur:
        batches.append(cur)
    return batches


def translate_utts(key, en_segments):
    """en segments -> zh segments (1:1 同序).

    en_segments: list[dict] with 'text' key
    returns: list[dict] with 'text' (zh), 同 start/end/speaker
    """
    texts = [seg["text"] for seg in en_segments]
    batches = chunk_by_chars(texts)
    zh_texts = []
    for i, batch in enumerate(batches):
        print(f"  [deepl] batch {i+1}/{len(batches)} ({len(batch)} utts, {sum(len(t) for t in batch)} chars)", flush=True)
        zh_texts.extend(translate_batch(key, batch))
        if i < len(batches) - 1:
            time.sleep(BATCH_PAUSE)

    out = []
    for en, zh_text in zip(en_segments, zh_texts):
        out.append({
            "start": en["start"],
            "end": en["end"],
            "speaker": en.get("speaker"),
            "text": zh_text.strip(),
        })
    return out


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) < 2:
        print("usage: deepl_translate.py <tag> <work_dir>", file=sys.stderr)
        print("  or:  deepl_translate.py <utt_clean.json> <gladia_zh.json>", file=sys.stderr)
        sys.exit(2)

    arg1, arg2 = argv[0], argv[1]

    # 模式 1: deepl_translate.py <tag> (默认 outputs/work/<tag>)
    # 模式 2: deepl_translate.py <utt_clean.json> <gladia_zh.json>
    if Path(arg2).exists() or arg2.endswith(".json"):
        utt_path = Path(arg1)
        out_path = Path(arg2)
    else:
        # tag 模式
        work_dir = Path(__file__).parent / arg1
        utt_path = work_dir / "utt_clean.json"
        out_path = work_dir / "gladia_zh.json"

    if not utt_path.exists():
        print(f"ERROR: {utt_path} not exists", file=sys.stderr)
        sys.exit(1)

    en_segments = json.loads(utt_path.read_text(encoding="utf-8"))
    print(f"[deepl] {len(en_segments)} en segments from {utt_path.name}", flush=True)

    # 如果输出已存在, 优先复用 zh 段 (避免重复消耗配额)
    existing_zh = {}
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding="utf-8"))
            for seg in prev.get("segments_zh", []):
                if seg.get("text"):
                    # 用 (start, end, text) 三元组做 cache key
                    key = (seg["start"], seg["end"], seg["text"])
                    existing_zh[key] = seg
        except Exception:
            pass

    if existing_zh:
        print(f"[deepl] {len(existing_zh)} cached zh segments from {out_path.name}", flush=True)

    # 过滤已翻译的, 只翻译新增的 (translation cache 优化)
    to_translate = []
    cache_hits = 0
    for seg in en_segments:
        key = (seg["start"], seg["end"], seg["text"])
        if key in existing_zh:
            cache_hits += 1
        else:
            to_translate.append(seg)
    print(f"[deepl] cache hit {cache_hits}/{len(en_segments)}, need translate {len(to_translate)}", flush=True)

    if not to_translate and existing_zh:
        # 全部 cache 命中, 直接用旧的 zh
        zh_segments = list(existing_zh.values())
    else:
        key = load_key()
        print(f"[deepl] key loaded, calling API...", flush=True)
        new_zh = translate_utts(key, to_translate)
        # 合并 cache + 新翻
        zh_segments = []
        new_idx = 0
        for seg in en_segments:
            cache_key = (seg["start"], seg["end"], seg["text"])
            if cache_key in existing_zh:
                zh_segments.append(existing_zh[cache_key])
            else:
                zh_segments.append(new_zh[new_idx])
                new_idx += 1

    # 写合并后的 en + zh 到 gladia_zh.json (en-only 流水线)
    out = {
        "duration": None,
        "language": "en",
        "segments_en": en_segments,
        "segments_zh": zh_segments,
        "_fetch_ts": time.time(),
        "_translator": "deepl-free",
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[deepl] wrote {len(en_segments)} en + {len(zh_segments)} zh to {out_path.name}", flush=True)
    print(f"[deepl] DONE", flush=True)
