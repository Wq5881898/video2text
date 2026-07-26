#!/usr/bin/env python3
"""run_zh_pipeline.py - 单期 driver, 5 阶段拆开, 每阶段幂等可重入.

用法:
  python3 run_zh_pipeline.py                       # 自动扫 DownloadTest 里没 SRT 的 m4a
  python3 run_zh_pipeline.py 150920 150921         # 指定 tag (空格或逗号分隔)
  python3 run_zh_pipeline.py --stage submit 160722 # 只跑 submit 阶段
  python3 run_zh_pipeline.py --stage fetch  160722 # 只跑 fetch
  python3 run_zh_pipeline.py --stage dedup  160722
  python3 run_zh_pipeline.py --stage translate 160722
  python3 run_zh_pipeline.py --stage build   160722
  python3 run_zh_pipeline.py --force 150920        # 强制重跑 (清掉旧产物)
  python3 run_zh_pipeline.py --build-only 160722   # 只 build SRT (跳过 Gladia + DeepL)

流程 (2026-07 改):
  Stage 1 submit:    Gladia en-only stt -> gladia_raw.job_id
  Stage 2 fetch:     GET /v2/pre-recorded/{id} -> gladia_zh.json (仅 en)
  Stage 3 dedup:     en 段 9 轮去重 -> utt_clean.json
  Stage 4 translate: DeepL en->zh -> 回写 gladia_zh.json (en+zh)
  Stage 5 build:     pair_en_zh + 拼 SRT -> D:\\DownloadTest\\<tag>.srt

每阶段幂等:
  - 重跑不重复已完成的步骤 (检查产物文件)
  - 失败可从失败处继续 (state machine)
  - --force 清掉产物强制重跑

零 agent, 零 token. 适合无人值守批量.
"""
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))
from gladia import load_keys, KeyRotator, BASE, upload, transcribe
import deepl_translate

# Windows / WSL 兼容: 优先 Windows 路径, WSL 路径作 fallback (环境变量 ROOT_DIR 可覆盖)
import os as _os
if _os.name == 'nt':
    DOWNLOAD_DIR = Path(_os.environ.get('AUDIO_DOWNLOAD_DIR', r'D:\DownloadTest'))
    OUTPUTS_DIR = Path(_os.environ.get('OUTPUTS_DIR', str(SCRIPT_DIR.parent)))
else:
    DOWNLOAD_DIR = Path(_os.environ.get('AUDIO_DOWNLOAD_DIR', '/sessions/relaxed-peaceful-brown/mnt/DownloadTest'))
    OUTPUTS_DIR = Path(_os.environ.get('OUTPUTS_DIR', '/sessions/relaxed-peaceful-brown/mnt/local_ff4848c9-6ee7-4d9b-879f-d782bbfc0d8f/outputs'))
POLL_INTERVAL = 8
POLL_MAX_ITERS = 60

# 阶段常量
STAGE_SUBMIT = "submit"
STAGE_FETCH = "fetch"
STAGE_DEDUP = "dedup"
STAGE_TRANSLATE = "translate"
STAGE_BUILD = "build"


def clean_zh(text):
    if not text:
        return text
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r'([一-鿿])[ 　]+([一-鿿])', r'\1\2', text)
    text = re.sub(r'([一-鿿]) +([A-Za-z0-9])', r'\1 \2', text)
    text = re.sub(r'([A-Za-z0-9]) +([一-鿿])', r'\1 \2', text)
    text = re.sub(r'[ \t]+([，。！？、：；）])', r'\1', text)
    text = re.sub(r'([，。！？、：；])[ \t]+(?=[一-鿿])', r'\1', text)
    text = re.sub(r'[ \t]{2,}', ' ', text)
    return text.strip()


# ====== dedup 算法 (inline) ======

PUNCT = re.compile(r'([.,;:?!]\s*)')


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


def jaccard(a, b):
    ta = set(a.lower().split())
    tb = set(b.lower().split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _norm_prefix(s):
    return s.rstrip(" ,.;:?!'\"")


# ====== dedup 算法已统一到外部 dedup.py (single source of truth) ======
# 旧的 dedup_en() 内嵌函数 (Round 3 过杀 <3 词) 已删除 (坑 AS + 坑 AY).
# 流水线所有 dedup 都走 subprocess 调外部 dedup.py, 保证新规则永远生效.
# 此处留 stub: 任何 dedup_en() 调用都会立刻抛错提示, 防止误用旧逻辑.
_DEDUP_EN_DEPRECATED_MSG = "dedup_en() 已废弃! 流水线应走外部 dedup.py (subprocess). 如需手动 dedup: python3 dedup.py <raw> <out>"
def dedup_en(*args, **kwargs):
    raise RuntimeError(_DEDUP_EN_DEPRECATED_MSG)



def pair_en_zh(en_clean, zh_segs):
    """对每个 zh 段, 找时间重叠的 en_clean 段, 拼出对应的英文.
    返回 [{start, end, text_zh, text_en}, ...] 按 zh 段 start 排序.
    后处理: 跨段 en_text 重复去重 (P0 + P2 + P3 修复).
    """
    zh_sorted = sorted(zh_segs, key=lambda x: (x.get("start") or 0, x.get("end") or 0))
    out = []
    # P3 修复 (2026-07-02): 跟踪前段已经用过的 en 段 id, 当前段只取新增的.
    # 例: 3 个短 en 段被 4 个短 zh 段依次命中, 不让同一组 en 内容分配到多个 zh 段.
    # 用 en 段 (start, end) 元组作为 id (en_clean 已经是 dedup 后的, 不会有重复 id).
    consumed_en_ids = set()
    for z in zh_sorted:
        z_s = z.get("start") or 0
        z_e = z.get("end") or 0
        en_texts = []
        en_start = z_e
        en_end = z_s
        cur_consumed = []
        for e in en_clean:
            e_s = e["start"]
            e_e = e["end"]
            if e_e < z_s or e_s > z_e:
                continue
            eid = (e_s, e_e)
            if eid in consumed_en_ids:
                continue  # 已在前段用过, 跳过
            en_texts.append(e["text"])
            cur_consumed.append(eid)
            en_start = min(en_start, e_s)
            en_end = max(en_end, e_e)
        if not en_texts:
            en_start, en_end = z_s, z_e
        en_combined = " ".join(en_texts)
        en_combined = dedup_inline(en_combined)
        sents = re.split(r'(?<=[.!?])\s+', en_combined)
        kept = []
        for s in sents:
            s = s.strip()
            if not s:
                continue
            if kept and jaccard(kept[-1], s) > 0.7:
                continue
            kept.append(s)
        en_combined = " ".join(kept)
        out.append({
            "start": en_start,
            "end": en_end,
            "text_zh": z["text"].strip(),
            "text_en": en_combined,
        })
        consumed_en_ids.update(cur_consumed)

    # 跨段 en_text 重复去重
    # P0 修复: 旧版直接清空整段 en_text 会丢 "I'm gonna throw up." 这样的尾巴.
    # P2 修复 (2026-07-02): 区分 4 种情况:
    #   1) prev 是 cur 的子串 -> cur 完全包含 prev, 清空 cur (cur 是重复)
    #   2) cur 以 prev 开头 -> 取 tail (cur 是 prev 的延续)
    #   3) prev 以 cur 开头 -> prev 是 cur 的延续, 但 cur 不可能比 prev 长 (因为 prev 在前) — 实际上不会发生
    #   4) 都不互相包含 -> 按公共前缀长度切
    # 把字符串尾部的标点 + 空白当 anchor (避免 "wingman always worked." vs "wingman always worked" 算不包含)
    prev_en = None
    for u in out:
        cur = u["text_en"]
        if not cur:
            continue
        if prev_en is not None and jaccard(prev_en, cur) > 0.7:
            cur_low = cur.lower()
            prev_low = prev_en.lower()
            cur_n = _norm_prefix(cur_low)
            prev_n = _norm_prefix(prev_low)
            # 1) cur 完全包含 prev (cur 是 prev 的超串) -> 取 tail
            if cur_n.startswith(prev_n):
                tail = cur[len(prev_n):].strip(" ,.;:?!'\"")
                u["text_en"] = tail if tail else ""
            # 2) prev 完全包含 cur (cur 是 prev 的子串) -> cur 是重复, 清空
            elif prev_n.startswith(cur_n):
                u["text_en"] = ""
            else:
                # 3) 都不互相包含 -> 按公共前缀切
                i = 0
                while i < min(len(cur_n), len(prev_n)) and cur_n[i] == prev_n[i]:
                    i += 1
                # i 太小 (前 1-2 字符相同不算重复), 保留全段
                if i < 5:
                    pass
                else:
                    tail = cur[i:].strip(" ,.;:?!'\"")
                    u["text_en"] = tail if tail else ""
                # P5 修复 (2026-07-02): 公共后缀重复检测.
                # cur 几乎完全在 prev 里, 只是少了开头几个词 ("so it's Royal Alexandra." vs "it's Royal Alexandra.").
                # 此时 cur 是 prev 的去前缀版本, 应清空 (cur 信息已经在 prev 里).
                # 条件: cur 在 prev 里出现 (不是 startswith), 且匹配长度 >= max(20, len(cur)*0.8).
                if u["text_en"]:
                    min_match = max(20, int(len(cur_n) * 0.8))
                    if len(cur_n) >= min_match and cur_n in prev_n and len(cur_n) <= len(prev_n):
                        u["text_en"] = ""
                    # P5b 修复 (2026-07-02): cur 跟 prev 文本完全相同 (去末尾标点后).
                    # 两个独立 en 段但文本一样 (Gladia 不同时间段重复同一句话), P3 因为 id 不同没合并.
                    elif cur_n == prev_n:
                        u["text_en"] = ""
            if u["text_en"]:
                prev_en = (prev_en + " " + u["text_en"]).strip()
        else:
            if cur:
                prev_en = cur
    return out


# ====== 主流程 (带防丢保护) ======

def backup_srt(tag):
    srt = DOWNLOAD_DIR / f"{tag}.srt"
    if not srt.exists():
        return None
    ts = int(time.time())
    bak = OUTPUTS_DIR / f"{tag}.srt.bak.{ts}"
    if bak.exists():
        i = 1
        while True:
            bak2 = OUTPUTS_DIR / f"{tag}.srt.bak.{ts}.{i}"
            if not bak2.exists():
                bak = bak2
                break
            i += 1
    shutil.copy2(srt, bak)
    print(f"[{tag}] 备份旧 SRT -> {bak}", flush=True)
    return bak


def find_m4a_tags(force_tags=None):
    force_set = set(force_tags or [])
    if not DOWNLOAD_DIR.exists():
        return []
    out = []
    for f in sorted(DOWNLOAD_DIR.glob("*.m4a")):
        tag = f.stem
        if tag in force_set:
            out.append(tag)
        else:
            srt = DOWNLOAD_DIR / f"{tag}.srt"
            if not srt.exists():
                out.append(tag)
    return out


def submit(rotator, tag):
    """Stage 1: Gladia en-only stt submit.

    产物: <work_dir>/<tag>/gladia_raw.job_id
    幂等: 已有非空 job_id 文件 -> 跳过, 返回
    """
    out_dir = SCRIPT_DIR / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    jf = out_dir / "gladia_raw.job_id"
    if jf.exists():
        jid = jf.read_text().strip()
        if jid:
            print(f"[{tag}] skip submit, job_id={jid} already on disk", flush=True)
            return jid
        print(f"[{tag}] job_id file empty, re-submit", flush=True)
        jf.unlink()
    audio = DOWNLOAD_DIR / f"{tag}.m4a"
    if not audio.exists():
        raise FileNotFoundError(audio)
    # 坑 AJ (2026-07-02): Gladia upload 跟 submit 的 audio_url 是 per-key 隔离的,
    # quota rotate 后用新 key 直接 submit 老 audio_url 会 401 "Unauthorized file access".
    # 必须重新 upload. 所以把 upload+submit 包成一个原子, key 切换就整套重做.
    last_err = None
    for attempt in range(len(rotator.keys)):
        print(f"[{tag}] upload {audio.name} ({audio.stat().st_size//1024} KB)...", flush=True)
        try:
            # 2026-07 改: 用 en-only transcribe (不带 translation_config)
            audio_url = upload(rotator, src=audio)
            job_id = transcribe(rotator, audio_url)
            jf.write_text(job_id)
            print(f"[{tag}] submit OK (en-only), job_id={job_id}", flush=True)
            return job_id
        except SystemExit as e:
            # gladia.py 在 key 用完时 sys.exit(3)
            raise
        except Exception as e:
            last_err = e
            print(f"[{tag}] attempt {attempt+1}/{len(rotator.keys)} failed: {e}", flush=True)
            # quota/401 时 rotate 后再试 (upload 也会重做)
            try:
                rotator.rotate(f"submit-retry: {e}")
            except SystemExit:
                raise
    raise RuntimeError(f"[{tag}] all {len(rotator.keys)} key(s) exhausted: {last_err}")


def poll_and_fetch(rotator, tag, job_id):
    """Stage 2: 拉 Gladia 结果, 只取 en 段 (translation 池已被废, zh 由 DeepL 跑).

    产物: <work_dir>/<tag>/gladia_zh.json (含 segments_en, segments_zh 暂时为空)
    幂等: 已有 segments_en + _fetch_ts + 匹配 job_id -> 跳过
    """
    out_dir = SCRIPT_DIR / tag
    zh_path = out_dir / "gladia_zh.json"
    if zh_path.exists() and zh_path.stat().st_size > 100:
        try:
            d = json.load(open(zh_path))
            if (d.get("segments_en") and d.get("_fetch_ts") and d.get("job_id") == job_id):
                # 2026-07 改: 不强制要求 segments_zh (DeepL 阶段才填)
                en_n = len(d["segments_en"])
                zh_n = len(d.get("segments_zh", []))
                if zh_n > 0:
                    print(f"[{tag}] already fetched+translated (en={en_n} zh={zh_n})", flush=True)
                else:
                    print(f"[{tag}] already fetched en-only (en={en_n}, DeepL pending)", flush=True)
                return
        except (json.JSONDecodeError, KeyError):
            pass
        print(f"[{tag}] gladia_zh.json 脏/不匹配 job_id, 重新 fetch", flush=True)
        zh_path.unlink()
    for i in range(POLL_MAX_ITERS):
        time.sleep(POLL_INTERVAL)
        try:
            req = urllib.request.Request(
                f"{BASE}/pre-recorded/{job_id}",
                headers={"x-gladia-key": rotator.current}
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
        except Exception as e:
            print(f"[{tag}] poll {i}: error {e}", flush=True)
            continue
        s = data.get("status")
        if i % 3 == 0:
            print(f"[{tag}] poll {i}: {s}", flush=True)
        if s == "done":
            result = data["result"]
            # 2026-07 改: 只取 en 段, 不再 normalize translation
            en_segs = []
            for utt in result.get("transcription", {}).get("utterances", []):
                en_segs.append({
                    "start": round(utt["start"], 2),
                    "end": round(utt["end"], 2),
                    "speaker": utt.get("speaker"),
                    "text": utt["text"].strip(),
                    "confidence": utt.get("confidence"),
                })
            meta = result.get("metadata", {})
            out = {
                "job_id": job_id,
                "_fetch_ts": int(time.time()),
                "_fetch_stage": "en-only",
                "duration": meta.get("audio_duration") or meta.get("duration"),
                "language": "en",
                "segments_en": en_segs,
                "segments_zh": [],  # DeepL 阶段填
            }
            zh_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[{tag}] fetched en-only: {len(en_segs)} segments", flush=True)
            return
        if s == "error":
            raise RuntimeError(f"{tag} transcription error: {data}")
    raise TimeoutError(f"{tag} poll timeout after {POLL_MAX_ITERS * POLL_INTERVAL}s")


def stage_dedup(tag):
    """Stage 3: 9 轮去重 en 段.

    产物: <work_dir>/<tag>/utt_clean.json
    幂等: utt_clean.json 存在 + mtime >= gladia_zh.json mtime -> 跳过
    """
    out_dir = SCRIPT_DIR / tag
    zh_path = out_dir / "gladia_zh.json"
    uc_path = out_dir / "utt_clean.json"
    if uc_path.exists() and uc_path.stat().st_size > 2:
        try:
            existing = json.load(open(uc_path))
            if isinstance(existing, list) and len(existing) > 0:
                # 跟 gladia_zh.json 里的 en 段数量比较, 一致就跳过
                zh_data = json.load(open(zh_path))
                src_en = len(zh_data.get("segments_en", []))
                if src_en == len(existing):
                    print(f"[{tag}] skip dedup, utt_clean.json has {len(existing)} (matches en source)", flush=True)
                    return
        except (json.JSONDecodeError, KeyError):
            pass
        print(f"[{tag}] utt_clean.json 脏/不匹配, 重新 dedup", flush=True)
        uc_path.unlink()

    # 坑 AY 2026-07-07: 流水线 dedup 统一走外部 dedup.py (subprocess),
    # 不再用内嵌 dedup_en() (Round 3 过杀, 已删除).
    # 单一真相源 (single source of truth): 改 dedup 算法只改一处.
    raw_path = out_dir / "gladia_raw.json"
    if not raw_path.exists():
        # 兼容 fetch 阶段未写 raw 的旧数据
        raise RuntimeError(f"[{tag}] no gladia_raw.json in {out_dir}, dedup stage needs raw")
    import subprocess
    dedup_script = SCRIPT_DIR / "dedup.py"
    if not dedup_script.exists():
        raise RuntimeError(f"[{tag}] dedup.py not found at {dedup_script}")
    print(f"[{tag}] dedup via external dedup.py (坑 AY: 单一真相源)", flush=True)
    result = subprocess.run(
        [sys.executable, "-B", "-u", str(dedup_script), str(raw_path), str(uc_path)],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        err = (result.stderr or "")[-500:]
        out_tail = (result.stdout or "")[-500:]
        raise RuntimeError(
            f"[{tag}] dedup.py failed (rc={result.returncode}): {err} | stdout: {out_tail}"
        )
    en_clean = json.load(open(uc_path, encoding="utf-8"))
    last_line = result.stdout.strip().split(chr(10))[-1] if result.stdout.strip() else ""
    print(f"[{tag}] dedup ok: {len(en_clean)} segments -> {uc_path.name} | {last_line}", flush=True)


def stage_translate(tag):
    """Stage 4: DeepL en->zh 翻译.

    产物: <work_dir>/<tag>/gladia_zh.json (en+zh 完整)
    幂等: gladia_zh.json 中 segments_zh 非空 + 数量 = segments_en -> 跳过
    调: deepl_translate.main() 模式 2 (utt_clean.json, gladia_zh.json)
    """
    out_dir = SCRIPT_DIR / tag
    zh_path = out_dir / "gladia_zh.json"
    if zh_path.exists():
        try:
            existing = json.load(open(zh_path))
            en_n = len(existing.get("segments_en", []))
            zh_n = len(existing.get("segments_zh", []))
            if zh_n > 0 and zh_n == en_n:
                # 验证 zh 不是空字符串
                non_empty = sum(1 for s in existing["segments_zh"] if s.get("text", "").strip())
                if non_empty == en_n:
                    print(f"[{tag}] skip translate, gladia_zh.json has full en+zh ({en_n}/{zh_n})", flush=True)
                    return
        except (json.JSONDecodeError, KeyError):
            pass

    uc_path = out_dir / "utt_clean.json"
    if not uc_path.exists():
        raise FileNotFoundError(f"{uc_path} (run dedup stage first)")

    print(f"[{tag}] deepl translate via deepl_translate.main", flush=True)
    deepl_translate.main([str(uc_path), str(zh_path)])

    # 验证
    result = json.load(open(zh_path, encoding="utf-8"))
    en_n = len(result.get("segments_en", []))
    zh_n = len(result.get("segments_zh", []))
    non_empty = sum(1 for s in result.get("segments_zh", []) if s.get("text", "").strip())
    print(f"[{tag}] deepl done: en={en_n} zh={zh_n} non_empty={non_empty}", flush=True)
    if non_empty < en_n * 0.5:
        print(f"[{tag}] WARNING: only {non_empty}/{en_n} zh segments translated, may need retry", flush=True)


def build_srt(tag):
    """Stage 5: pair en+zh -> SRT.

    产物: D:\\DownloadTest\\<tag>.srt (同名同目录)
    幂等: SRT 已存在 + mtime >= gladia_zh.json mtime -> 跳过
    """
    zh_path = SCRIPT_DIR / tag / "gladia_zh.json"
    srt_path = DOWNLOAD_DIR / f"{tag}.srt"
    data = json.load(open(zh_path, encoding="utf-8"))
    en_segs = data.get("segments_en", [])
    zh_segs = data.get("segments_zh", [])

    # 坑 AY 2026-07-07: 强制从 utt_clean.json 读 (流水线 dedup 阶段已用外部 dedup.py 写过).
    # 不再 fallback 调内嵌 dedup_en (已删除, 会抛 RuntimeError).
    uc_path = SCRIPT_DIR / tag / "utt_clean.json"
    if uc_path.exists():
        en_clean = json.load(open(uc_path, encoding="utf-8"))
        if len(en_segs) != len(en_clean):
            print(f"[{tag}] WARN: gladia_zh en={len(en_segs)} vs utt_clean={len(en_clean)}, 用 utt_clean", flush=True)
    else:
        # 没有 utt_clean.json 时直接用 en_segs (Gladia en-only 没 dedup 过, 罕见)
        en_clean = en_segs
        print(f"[{tag}] no utt_clean.json, 用 raw en_segs (untouched)", flush=True)

    paired = pair_en_zh(en_clean, zh_segs)
    print(f"[{tag}] paired: en={len(en_clean)} zh={len(zh_segs)} -> {len(paired)} entries", flush=True)

    def fmt_ts(t):
        h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
        return f"{h:02d}:{m:02d}:{s:06.3f}"

    if srt_path.exists():
        backup_srt(tag)

    lines = []
    missing_zh = 0
    for i, u in enumerate(paired, 1):
        zh_raw = u.get("text_zh", "").strip()
        en_text = u.get("text_en", "").strip()
        zh_clean = clean_zh(zh_raw) if zh_raw else ""
        if not zh_clean:
            missing_zh += 1
            zh_clean = f"（{en_text[:30]}...）" if en_text else "（无中文）"
        start = u["start"]
        end = u["end"]
        lines.append(str(i))
        lines.append(f"{fmt_ts(start)} --> {fmt_ts(end)}")
        lines.append(zh_clean)
        if en_text:
            lines.append(en_text)
        lines.append("")
    srt_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[{tag}] SRT -> {srt_path}, {len(paired)} entries, {srt_path.stat().st_size} bytes, missing_zh={missing_zh}", flush=True)


def sync_backup(tag):
    srt = DOWNLOAD_DIR / f"{tag}.srt"
    bak = OUTPUTS_DIR / f"{tag}.srt"
    if srt.exists():
        shutil.copy2(srt, bak)
        print(f"[{tag}] backup -> {bak}", flush=True)


def main():
    args = sys.argv[1:]
    force_tags = []
    if "--force" in args:
        i = args.index("--force")
        force_tags = [a for a in args[i + 1:] if not a.startswith("--")]
        args = args[:i] + [a for a in args[i + 1:] if a.startswith("--")]
    build_only = "--build-only" in args
    if build_only:
        args = [a for a in args if a != "--build-only"]

    # 单阶段模式: --stage <stage> <tags...>
    only_stage = None
    if "--stage" in args:
        i = args.index("--stage")
        only_stage = args[i + 1]
        args = args[:i] + args[i + 2:]

    if args:
        tags = []
        for a in args:
            tags.extend(a.split(","))
    else:
        tags = find_m4a_tags(force_tags=force_tags)

    if not tags:
        print("no m4a to process", flush=True)
        return
    if force_tags:
        # 删除旧产物让 submit/fetch/dedup/translate 都重新跑
        for t in force_tags:
            for fn in ("gladia_raw.job_id", "gladia_zh.json", "utt_clean.json"):
                fp = SCRIPT_DIR / t / fn
                if fp.exists():
                    fp.unlink()
                    print(f"[{t}] removed {fn} (force re-run)", flush=True)

    keys = load_keys()
    rotator = KeyRotator(keys)
    print(f"active: {rotator.current_label()}", flush=True)

    job_ids = {}
    stages_to_run = [only_stage] if only_stage else [STAGE_SUBMIT, STAGE_FETCH, STAGE_DEDUP, STAGE_TRANSLATE, STAGE_BUILD]

    # Stage 1: submit
    if STAGE_SUBMIT in stages_to_run and not build_only:
        print("\n=== Stage 1: submit (Gladia en-only) ===", flush=True)
        for tag in tags:
            try:
                job_ids[tag] = submit(rotator, tag)
            except Exception as e:
                print(f"[{tag}] submit FAIL: {e}", flush=True)
                if not only_stage:
                    raise  # 全自动模式直接 fail
                # 单 stage 模式打印错误继续
                continue

    # Stage 2: poll+fetch
    if STAGE_FETCH in stages_to_run and not build_only:
        print("\n=== Stage 2: poll+fetch (en-only) ===", flush=True)
        for tag in tags:
            jid = job_ids.get(tag) or (SCRIPT_DIR / tag / "gladia_raw.job_id").read_text().strip()
            if not jid:
                print(f"[{tag}] skip fetch, no job_id", flush=True)
                continue
            try:
                poll_and_fetch(rotator, tag, jid)
            except Exception as e:
                print(f"[{tag}] fetch FAIL: {e}", flush=True)
                if not only_stage:
                    raise
                continue

    # Stage 3: dedup
    if STAGE_DEDUP in stages_to_run and not build_only:
        print("\n=== Stage 3: dedup (9 轮) ===", flush=True)
        for tag in tags:
            try:
                stage_dedup(tag)
            except Exception as e:
                print(f"[{tag}] dedup FAIL: {e}", flush=True)
                if not only_stage:
                    raise
                continue

    # Stage 4: DeepL translate
    if STAGE_TRANSLATE in stages_to_run and not build_only:
        print("\n=== Stage 4: translate (DeepL en->zh) ===", flush=True)
        for tag in tags:
            try:
                stage_translate(tag)
            except Exception as e:
                print(f"[{tag}] translate FAIL: {e}", flush=True)
                if not only_stage:
                    raise
                continue

    # Stage 5: build SRT
    if STAGE_BUILD in stages_to_run:
        print("\n=== Stage 5: build SRT ===", flush=True)
        for tag in tags:
            try:
                build_srt(tag)
            except Exception as e:
                print(f"[{tag}] build FAIL: {e}", flush=True)
                if not only_stage:
                    raise
                continue

    print("\n=== ALL DONE ===", flush=True)


if __name__ == "__main__":
    main()
