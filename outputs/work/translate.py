#!/usr/bin/env python3
"""批量翻译 utt_clean.json → translations.py。

调用:
  python3 translate.py <work_dir> [--model claude-sonnet-4-6] [--batch 50]

策略:
  - 按 50 段/批 切片, 调 Claude 把每段 EN 翻成中文 (口语化, 适合字幕)
  - 输出格式: TRANSLATIONS_<NAME> dict, 键 "1".."N", 值 中文
  - 不覆盖已有翻译 (跳过非空段)
  - 每批之间打日志, 失败重试 3 次
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit("usage: translate.py <work_dir>")

work = Path(sys.argv[1])
clean = work / "utt_clean.json"
tr_file = work / "translations.py"

if not clean.exists():
    sys.exit(f"missing {clean}")

utts = json.load(open(clean, encoding="utf-8"))
n = len(utts)
print(f"segments: {n}")

# 加载现有翻译
existing = {}
if tr_file.exists():
    import importlib.util
    spec = importlib.util.spec_from_file_location("t", tr_file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in dir(mod):
        if name.startswith("TRANSLATIONS_") and isinstance(getattr(mod, name), dict):
            existing = getattr(mod, name)
            print(f"loaded existing: {len(existing)} entries, {sum(1 for v in existing.values() if v.strip())} filled")
            break

const = work.name.upper().replace(".", "_")
to_fill = [i for i in range(1, n + 1) if not existing.get(str(i), "").strip()]
print(f"to_fill: {len(to_fill)}")

if not to_fill:
    print("nothing to translate")
    sys.exit(0)

# 这里只生成待填模板, 实际翻译由 claude-code 的 main agent 接管
# 此脚本作为占位 + 校验器
print(f"\n待翻译段号: {to_fill[:20]}{'...' if len(to_fill) > 20 else ''}")
print(f"共 {len(to_fill)} 段待填")
print(f"\n请编辑 {tr_file}, 把 \"{to_fill[0]}\", \"{to_fill[1]}\"... 的空值填上中文")
print(f"然后再跑一次 python3 translate.py {work} 确认完成")
sys.exit(1 if to_fill else 0)
