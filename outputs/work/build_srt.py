#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成双语 SRT - 通过 markdown 抽取中文 + 自动占位缺失项"""
import json, re

EN = json.load(open("/sessions/zealous-upbeat-ritchie/mnt/outputs/work/utt_final3.json"))
md = open("/sessions/zealous-upbeat-ritchie/mnt/outputs/Naked_News-2025.08.14_中英脚本.md", encoding="utf-8").read()

# 从 md 抽中文 - 用 "第3列" 解析
md_zh = []
for line in md.split("\n"):
    # 匹配: | [时间] | 英文 | 中文 |
    if not re.match(r"^\|\s*\[\d+:\d+\]\s*\|", line):
        continue
    # 用 " | " 分割但限制段数（最后一段是中文）
    # 因为 EN/ZH 里可能含 "|", 用 rsplit 找最后两个
    # 实际：行末是 " | 中文 | "
    # 找 " | " 出现位置，倒数第2个开始是中文
    parts = line.rsplit(" | ", 2)
    if len(parts) >= 2:
        zh = parts[-2].strip() if parts[-1].strip() == "" else parts[-1].strip()
        md_zh.append(zh)

print(f"md 中抽到: {len(md_zh)} 条中文")

# 建立 EN->ZH 对齐：以时间戳 [mm:ss] 为 key
md_lookup = {}
for line in md.split("\n"):
    m = re.match(r"^\|\s*\[(\d+):(\d+)\]\s*\|", line)
    if not m: continue
    ts = f"{m.group(1)}:{m.group(2)}"
    parts = line.rsplit(" | ", 2)
    if len(parts) >= 2:
        zh = parts[-2].strip() if parts[-1].strip() == "" else parts[-1].strip()
        if ts in md_lookup:
            md_lookup[ts] = md_lookup[ts] + "/" + zh  # 多个取合并
        else:
            md_lookup[ts] = zh

print(f"unique timestamps in md: {len(md_lookup)}")

# 对每段 EN 找对应中文
def ts_key(t):
    return f"{int(t//60):02d}:{int(t%60):02d}"

result = []
missing = []
for i, u in enumerate(EN, 1):
    ts = ts_key(u["start"])
    if ts in md_lookup:
        zh = md_lookup[ts]
        result.append((i, u, zh))
    else:
        result.append((i, u, None))
        missing.append((i, ts, u["text"][:60]))

print(f"matched: {len(result)-len(missing)}, missing: {len(missing)}")
if missing:
    print("\n--- missing entries ---")
    for i, ts, en in missing:
        print(f"{i:3d} [{ts}] {en}")

# 找出 md 中匹配但 EN 时间戳最近的那条作为参考（同一句的重复）
# 对 missing 找时间最近（差 < 2s）的 md 条目
md_times = sorted([(k, v) for k, v in md_lookup.items()], key=lambda x: int(x[0].split(":")[0])*60+int(x[0].split(":")[1]))

def parse_ts(s):
    m, s_ = s.split(":")
    return int(m)*60 + int(s_)

md_idx = [(parse_ts(k), v) for k, v in md_lookup.items()]

filled = []
for i, u, zh in result:
    if zh is not None:
        filled.append((i, u, zh))
        continue
    # 找最近
    t = u["start"]
    closest = min(md_idx, key=lambda x: abs(x[0]-t))
    if abs(closest[0]-t) < 3.0:
        # 视为同一句的重复
        filled.append((i, u, closest[1] + "（同前）"))
    else:
        # 占位
        filled.append((i, u, f"（{u['text'][:30]}...）"))

# 输出 SRT
def fmt_ts(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

lines = []
for i, u, zh in filled:
    en = u["text"].strip()
    lines.append(str(i))
    lines.append(f"{fmt_ts(u['start'])} --> {fmt_ts(u['end'])}")
    lines.append(zh)
    lines.append(en)
    lines.append("")

content = "\n".join(lines)
out_path = "/sessions/zealous-upbeat-ritchie/mnt/outputs/Naked_News-2025.08.14_中英字幕.srt"
with open(out_path, "w", encoding="utf-8") as f:
    f.write(content)
print(f"\nOK -> {out_path}")
print(f"total entries: {len(filled)}")
print(f"file size: {len(content.encode('utf-8'))} bytes")

# 列出缺失占位的条目
print("\n--- 占位条目（需要手动补中文）---")
for i, u, zh in filled:
    if zh.startswith("（") and zh.endswith("）"):
        print(f"{i:3d} [{ts_key(u['start'])}] {u['text'][:70]}")
PY