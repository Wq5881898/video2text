#!/usr/bin/env python3
"""Gladia 转写结果去重 (2026-07-06 重构, 坑 AS).

核心原则 (用户决策 2026-07-06):
  - 只去重 + 合并, 不删任何段
  - 不管长短、不管 conf 多低, 都保留 (Gladia 听错碎片也保留, 后加 * 标记)
  - 短片段合并到相邻段形成完整句子
  - conf < 0.4 的段 text 末尾加 '*' 标记

8 轮流水线:
  R0: strip 空段 / 纯标点段
  R1: 段内三策略去重 ("X. X." / 词对半 / N-gram 嵌套)
  R2: 相邻 jaccard>0.7 合并 (合成完整句子)
  R3: 相邻 text 完全相同 (normalized) 去重 - 保留第一条
  R4: 跨段 jaccard>0.7 + time<1.5s 合并
  R5: <3 词 AND dur<0.8s AND gap<1.5s → 合并到前段 (不删, 内容都在)
  R6: 再次段内去重 (兜底)
  R7: conf<0.4 段 text 末尾加 '*' 标记

输入格式:
  - 新 Gladia v2: {"segments": [...]}
  - 旧 Gladia v1: {"transcription": {"utterances": [...]}}
"""
import json
import re
import sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit("usage: dedup.py <raw_json> [out_json]")

raw_path = Path(sys.argv[1])
out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else raw_path.parent / "utt_clean.json"

with raw_path.open("r", encoding="utf-8") as handle:
    raw = json.load(handle)
if "transcription" in raw and "utterances" in raw["transcription"]:
    utts = raw["transcription"]["utterances"]
elif "segments" in raw:
    utts = raw["segments"]
else:
    utts = []
print("raw:", len(utts), "utterances", flush=True)

LOW_CONF_THRESHOLD = 0.4  # < 此值加 * 标记
MERGE_FRAGMENT_DURATION = 0.8  # 短碎片判定 duration 阈值 (坑 AO)
MERGE_FRAGMENT_GAP = 1.5  # 短碎片跟前段合并的最大时间间隔

# ===== Round 0: strip 空段 / 纯标点段 =====
merged = []
for u in utts:
    t = u["text"].strip()
    if not t or not any(c.isalnum() for c in t):
        continue
    merged.append({
        "start": u["start"],
        "end": u["end"],
        "speaker": u.get("speaker"),
        "text": t,
        "confidence": u.get("confidence"),
    })
print("round0 (strip empty/punct-only):", len(merged), flush=True)


def jaccard(a, b):
    ta = set(a.lower().split())
    tb = set(b.lower().split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


PUNCT = re.compile(r"([.,;:?!]\s*)")


def split_sents(t):
    parts = PUNCT.split(t)
    out = []
    i = 0
    while i < len(parts):
        if i + 1 < len(parts) and PUNCT.match(parts[i + 1]):
            out.append((parts[i], parts[i + 1]))
            i += 2
        else:
            if parts[i].strip():
                out.append((parts[i], ""))
            i += 1
    return out


def dedup_inline(text):
    """三策略组合 (段内去重, 不跨段):
    1. 按标点切分, 相邻两段相同则去后半 (修 "X. X." / "X. X. X." 这种 N 连重复)
    2. 词对半切, 前后两半相同则保留前半 (修无标点的 "X X X X" 这种)
    3. N-gram 嵌套: 前段末尾 N 词 == 后段全部, 则去后半 (修 "X. and X" 这种前段包含后段)
    """
    t = text.strip()
    if not t:
        return t
    sents = split_sents(t)
    deduped = []
    for s, sep in sents:
        s_norm = s.strip().lower()
        if deduped and deduped[-1][0].strip().lower() == s_norm:
            if not deduped[-1][1] and sep:
                deduped[-1] = (deduped[-1][0], sep)
            continue
        deduped.append((s, sep))
    out = "".join(s + sep for s, sep in deduped).strip()
    if out != t:
        return out
    words = t.split()
    n = len(words)
    if n >= 4 and n % 2 == 0:
        half = n // 2
        if [w.lower() for w in words[:half]] == [w.lower() for w in words[half:]]:
            return " ".join(words[:half])
    if len(sents) >= 2:
        last_text = sents[-1][0].strip()
        last_words = [w.lower() for w in last_text.split()]
        prev_text = sents[-2][0].strip()
        prev_words = [w.lower() for w in prev_text.split()]
        m = len(last_words)
        if m > 0 and len(prev_words) > m and prev_words[-m:] == last_words:
            return "".join(s + sep for s, sep in sents[:-1]).strip()
    return t


def norm_text(t):
    """归一化: 小写 + 收尾空白/标点. 用于 Round 3 完全相同去重."""
    return t.strip().lower().rstrip(".,;:?! ")


# ===== Round 1: 段内三策略去重 =====
for u in merged:
    u["text"] = dedup_inline(u["text"])
print("round1 (inline dedup): same count, normalized text", flush=True)

# ===== Round 2: 相邻 jaccard > 0.7 合并 =====
merged2 = []
for u in merged:
    t = u["text"]
    if merged2 and jaccard(merged2[-1]["text"], t) > 0.7:
        prev = merged2[-1]
        prev["end"] = u["end"]
        prev["text"] = prev["text"] + " " + t
        # conf 取两段平均 (简化: 取较小, 表示不确定)
        if u.get("confidence") is not None and prev.get("confidence") is not None:
            prev["confidence"] = min(prev["confidence"], u["confidence"])
    else:
        merged2.append({
            "start": u["start"], "end": u["end"],
            "speaker": u.get("speaker"), "text": t,
            "confidence": u.get("confidence"),
        })
merged = merged2
print("round2 (jaccard>0.7 merge):", len(merged), flush=True)

# ===== Round 3 (NEW): 相邻 text 完全相同 (normalized) 去重 =====
# 用户决策 2026-07-06: 完全相同的相邻段直接删第二条, 保留第一条
# 注意: 只对相邻段判断, 中间隔了一段不删
merged3 = []
for u in merged:
    t_norm = norm_text(u["text"])
    if merged3 and norm_text(merged3[-1]["text"]) == t_norm and t_norm:
        # 跳过完全重复的相邻段
        continue
    merged3.append(u)
merged = merged3
print("round3 (drop adjacent exact dup):", len(merged), flush=True)

# ===== Round 4: 跨段 jaccard > 0.7 + 时间窗<1.5s 合并 =====
i = 0
while i < len(merged) - 1:
    a, b = merged[i], merged[i + 1]
    if jaccard(a["text"], b["text"]) > 0.7 and abs(b["start"] - a["end"]) < 1.5:
        a["end"] = b["end"]
        a["text"] = a["text"] + " " + b["text"]
        if a.get("confidence") is not None and b.get("confidence") is not None:
            a["confidence"] = min(a["confidence"], b["confidence"])
        merged.pop(i + 1)
    else:
        i += 1
print("round4 (cross jaccard>0.7 + time<1.5s):", len(merged), flush=True)

# ===== Round 5 (重写, 坑 AS): <3 词 AND dur<0.8s 合并到前段 (不删) =====
# 用户决策 2026-07-06: 不删任何段. 短碎片合并到前段形成完整句子.
# 条件放宽: <3 词 AND dur<0.8s AND 时间间隔<1.5s AND 同 speaker → 合并到前段
# - 不删, 内容全在
# - 真人短语 (dur>0.8s) 保留独立
# - 没前段 (i=0) 保留独立
merged5 = list(merged)
i = 0
while i < len(merged5):
    cur = merged5[i]
    nw = len(cur["text"].split())
    duration = cur["end"] - cur["start"]
    if nw < 3 and duration < MERGE_FRAGMENT_DURATION and i > 0:
        prev = merged5[i - 1]
        # 检查时间间隔 + speaker 一致 (避免跨说话人合并)
        gap = cur["start"] - prev["end"]
        same_speaker = (prev.get("speaker") is None or cur.get("speaker") is None
                        or prev.get("speaker") == cur.get("speaker"))
        if gap < MERGE_FRAGMENT_GAP and same_speaker:
            # 合并到前段 (内容都在)
            prev["end"] = cur["end"]
            prev["text"] = prev["text"] + " " + cur["text"]
            if prev.get("confidence") is not None and cur.get("confidence") is not None:
                prev["confidence"] = min(prev["confidence"], cur["confidence"])
            merged5.pop(i)
            continue  # 不 i+=1, 继续看下一段 (可能继续合并)
    i += 1
merged = merged5
print(f"round5 (merge <3w+dur<{MERGE_FRAGMENT_DURATION}s+gap<{MERGE_FRAGMENT_GAP}s to prev, NO DELETE):",
      len(merged), flush=True)

# ===== Round 6: 再次段内去重 (兜底) =====
for u in merged:
    u["text"] = dedup_inline(u["text"])
print("round6 (inline dedup final): same count, normalized", flush=True)

# ===== Round 7 (NEW): conf < 0.4 段 text 末尾加 '*' 标记 =====
# 用户决策 2026-07-06: 低 conf 段不删, 但加 * 提示听录可能有误
star_count = 0
for u in merged:
    c = u.get("confidence")
    if c is not None and c < LOW_CONF_THRESHOLD and not u["text"].rstrip().endswith("*"):
        u["text"] = u["text"].rstrip() + "*"
        star_count += 1
print(f"round7 (mark conf<{LOW_CONF_THRESHOLD} with '*'):", star_count, "marked, total",
      len(merged), flush=True)

# 输出前先去掉 confidence 字段 (utt_clean.json 给 DeepL 用, 不要 conf 噪音)
out_segments = []
for u in merged:
    out_segments.append({
        "start": u["start"],
        "end": u["end"],
        "speaker": u.get("speaker"),
        "text": u["text"],
    })

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out_segments, f, ensure_ascii=False, indent=2)
print(f"OK -> {out_path}, {len(out_segments)} segments", flush=True)
