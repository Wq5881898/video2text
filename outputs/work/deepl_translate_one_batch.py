#!/usr/bin/env python3
"""deepl_translate_one_batch.py - 跑单个 batch 的 deepl 翻译.

坑 P 修复: bash 工具 45s 超时, deepl_translate 一次性 283 段会被砍.
拆成单 batch (≤50 段, ≤10s 调用), 配合外面 bash 串行调.

用法:
  python3 deepl_translate_one_batch.py <utt_clean.json> <out.json> <batch_idx> [total_batches]

每跑一次只翻译一批, 把结果追加到 out.json:
  - out.json 第一次创建时, 包含 header {en_count, batch_size, ...}
  - 每次追加: out.json["batches"][batch_idx] = {en, zh, count}

外部 driver 拼装回 gladia_zh.json 格式.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

SCRIPT_DIR = Path(__file__).parent
DEEPL_URL = "https://api-free.deepl.com/v2/translate"
SOURCE_LANG = "EN"
TARGET_LANG = "ZH"
BATCH_SIZE = 50
MAX_RETRIES = 3
RETRY_PAUSE = 5


def load_key():
    k = os.environ.get("DEEPL_KEY", "").strip()
    if k:
        return k
    p = SCRIPT_DIR / "deeplkey.txt"
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    p2 = SCRIPT_DIR / "deepl_key"
    if p2.exists():
        return p2.read_text(encoding="utf-8").strip()
    raise FileNotFoundError("no DeepL key in env or deeplkey.txt/deepl_key")


def translate_batch(key, texts):
    if not texts:
        return []
    parts = [f"text={quote(t, safe='')}" for t in texts]
    parts.append(f"source_lang={SOURCE_LANG}")
    parts.append(f"target_lang={TARGET_LANG}")
    body = "&".join(parts).encode("utf-8")
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
                raise RuntimeError(f"deepl returned {len(translations)} for {len(texts)} inputs")
            return [t["text"] for t in translations]
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            print(f"  [batch] attempt {attempt+1} failed: {last_err}", flush=True)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_PAUSE)
    raise RuntimeError(f"batch failed: {last_err}")


def main():
    if len(sys.argv) < 4:
        sys.exit("usage: deepl_translate_one_batch.py <utt.json> <out.json> <batch_idx>")
    utt_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    batch_idx = int(sys.argv[3])

    en_segments = json.loads(utt_path.read_text(encoding="utf-8"))
    # 按 BATCH_SIZE 切
    batches = []
    for i in range(0, len(en_segments), BATCH_SIZE):
        batches.append(en_segments[i:i + BATCH_SIZE])
    if batch_idx >= len(batches):
        print(f"SKIP batch_idx {batch_idx} >= total {len(batches)}")
        return

    batch = batches[batch_idx]
    print(f"[batch {batch_idx+1}/{len(batches)}] {len(batch)} segs", flush=True)
    key = load_key()
    texts = [s["text"] for s in batch]
    zh_texts = translate_batch(key, texts)

    # 写单 batch 结果 (append 到 out.json 的 batches 数组)
    if out_path.exists():
        out = json.loads(out_path.read_text(encoding="utf-8"))
    else:
        out = {"en_count": len(en_segments), "batch_size": BATCH_SIZE,
               "batches": [None] * len(batches), "completed": []}
    out["batches"][batch_idx] = {
        "start_in_en": batch_idx * BATCH_SIZE,
        "count": len(batch),
        "en": batch,
        "zh": zh_texts,
    }
    if batch_idx not in out["completed"]:
        out["completed"].append(batch_idx)
    out["completed"].sort()
    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"OK batch {batch_idx+1} -> {len(zh_texts)} zh", flush=True)


if __name__ == "__main__":
    main()
