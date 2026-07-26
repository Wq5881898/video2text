#!/usr/bin/env python3
"""从 Gladia 带翻译的输出直接出双语 SRT.

跟 build_srt_v2.py 的区别:
  - 不需要单独的 utt_clean.json 和 translations.py
  - 直接吃 gladia_zh.json (里面已有 en + zh utterances, 时间戳 1:1)
  - 自动清理 Gladia 翻译的字间空格 (不检查翻译质量)
  - 输出格式: 中→英 双行 (跟 build_srt_v2 一致)

用法:
  python3 build_srt_from_gladia_zh.py <gladia_zh.json> <out.srt>
"""
import sys
import json
import re
from pathlib import Path

if len(sys.argv) < 3:
    sys.exit("usage: build_srt_from_gladia_zh.py <gladia_zh.json> <out.srt>")

in_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])

data = json.load(open(in_path, encoding="utf-8"))
en_segs = data.get("segments_en", [])
zh_segs = data.get("segments_zh", [])

if len(en_segs) != len(zh_segs):
    print(f"WARN: en={len(en_segs)} vs zh={len(zh_segs)} (按 en 对齐)", file=sys.stderr)


def clean_zh(text):
    """去 Gladia 翻译里的字间空格, 标点间距修复. 不做语义校对."""
    if not text:
        return text
    # 反复去汉字间空格, 直到稳定 (处理多空格叠加)
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r'([一-鿿])[ 　]+([一-鿿])', r'\1\2', text)
    # 中英之间保留单空格
    text = re.sub(r'([一-鿿]) +([A-Za-z0-9])', r'\1 \2', text)
    text = re.sub(r'([A-Za-z0-9]) +([一-鿿])', r'\1 \2', text)
    # 标点前空格去掉
    text = re.sub(r'[ \t]+([，。！？、：；）])', r'\1', text)
    # 标点后空格去掉 (除非后面是英文/数字)
    text = re.sub(r'([，。！？、：；])[ \t]+(?=[一-鿿])', r'\1', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    return text.strip()


def fmt_ts(t):
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


lines = []
missing_zh = []
for i, (e, z) in enumerate(zip(en_segs, zh_segs), 1):
    en_text = e["text"].strip()
    zh_raw = z["text"].strip()
    zh_clean = clean_zh(zh_raw)
    if not zh_clean:
        missing_zh.append(i)
        # 跟 build_srt_v2 行为一致: 空段用 en 截断占位
        zh_clean = f"（{en_text[:30]}...）"

    start = e.get("start") or z.get("start") or 0
    end = e.get("end") or z.get("end") or 0
    lines.append(str(i))
    lines.append(f"{fmt_ts(start)} --> {fmt_ts(end)}")
    lines.append(zh_clean)
    lines.append(en_text)
    lines.append("")

content = "\n".join(lines)
out_path.write_text(content, encoding="utf-8")
print(f"OK -> {out_path}, {len(en_segs)} entries, {len(content.encode('utf-8'))} bytes")
if missing_zh:
    print(f"empty_zh: {len(missing_zh)} segments ({missing_zh[:5]}...)")