#!/usr/bin/env python3
"""生成双语 SRT - 吃 utt_clean.json + translations.py"""
import sys, json
from pathlib import Path

# usage: build_srt_v2.py <utt_clean.json> <translations.py> <out.srt>
if len(sys.argv) < 4:
    sys.exit("usage: build_srt_v2.py <utt_clean.json> <translations.py> <out.srt>")

utt_path = Path(sys.argv[1])
tr_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])

utts = json.load(open(utt_path))

# 自动 strip translations.py 末尾的 NUL 字节（Write/Edit 工具偶尔会追加）
tr_bytes = tr_path.read_bytes()
if b'\x00' in tr_bytes:
    tr_path.write_bytes(tr_bytes.replace(b'\x00', b''))
    print(f"[clean] stripped NUL bytes from {tr_path.name}", file=sys.stderr)

sys.path.insert(0, str(tr_path.parent))
import importlib.util
spec = importlib.util.spec_from_file_location("translations", tr_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# 找 TRANSLATIONS_xxx dict
trans = None
for name in dir(mod):
    if name.startswith("TRANSLATIONS_") and isinstance(getattr(mod, name), dict):
        trans = getattr(mod, name)
        break
if not trans:
    sys.exit("no TRANSLATIONS_* dict in translations.py")

print(f"utts: {len(utts)}, translations: {len(trans)}")

def fmt_ts(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

lines = []
missing = []
for i, u in enumerate(utts, 1):
    zh = trans.get(str(i), "").strip()
    if not zh:
        missing.append(i)
        zh = f"（{u['text'][:30]}...）"
    en = u["text"].strip()
    lines.append(str(i))
    lines.append(f"{fmt_ts(u['start'])} --> {fmt_ts(u['end'])}")
    lines.append(zh)
    lines.append(en)
    lines.append("")

content = "\n".join(lines)
out_path.write_text(content, encoding="utf-8")
print(f"OK -> {out_path}, {len(utts)} entries, {len(content.encode('utf-8'))} bytes")
if missing:
    print(f"MISSING translations: {missing}")
