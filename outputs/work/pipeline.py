#!/usr/bin/env python3
"""一键跑完一遍音频 → 双语 SRT。

输入: 任意 .m4a/.mp3/.wav
输出: 同目录同名 .srt (或 -o 指定)

调用:
  python3 pipeline.py <audio>                       # 默认输出到 D:/DownloadTest/ 同名 .srt
  python3 pipeline.py <audio> -o <out_srt>          # 自定义输出
  python3 pipeline.py <audio> --work-dir <dir>      # 自定义中间文件目录

步骤:
  1. gladia.py 上传转写 → <work>/gladia_raw.json
  2. dedup.py 去重      → <work>/utt_clean.json
  3. 生成翻译模板        → <work>/translations.py (空 dict, 序号 "1".."N")
  4. 用户填好中文后:
     5. build_srt_v2.py → 输出 SRT

step 1-3 是连跑, step 4 是阻塞点 (用户填译文), step 5 用 --build-only 重跑.

踩坑记录:
  - 不要用本脚本跨 Windows 路径 (./ 是 Linux VM 视角), 输入输出必须绝对路径
  - work-dir 默认 = outputs/work/<音频 basename 不含后缀>
  - 如果 utt_clean.json 已存在, 跳过 step1+step2 节省转写时间
  - 如果 translations.py 已有非空内容, 不覆盖
"""
import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DEFAULT_WORK_ROOT = SCRIPT_DIR
DEFAULT_OUT_ROOT = Path("/sessions/relaxed-peaceful-brown/mnt/DownloadTest")


def run(cmd, **kw):
    print(f"$ {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run(cmd, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("-o", "--out-srt", type=Path, default=None,
                    help="输出 SRT 路径, 默认 <音频目录>/<音频 stem>.srt")
    ap.add_argument("--work-dir", type=Path, default=None,
                    help="中间文件目录, 默认 outputs/work/<stem>")
    ap.add_argument("--build-only", action="store_true",
                    help="跳过转写+去重, 只跑 build_srt (需 utt_clean + translations 已存在)")
    ap.add_argument("--skip-translation-template", action="store_true",
                    help="不生成翻译模板")
    args = ap.parse_args()

    if not args.audio.exists():
        sys.exit(f"audio not found: {args.audio}")

    stem = args.audio.stem  # e.g. 250908
    work = args.work_dir or (DEFAULT_WORK_ROOT / stem)
    out_srt = args.out_srt or (args.audio.parent / f"{stem}.srt")

    work.mkdir(parents=True, exist_ok=True)
    raw_json = work / "gladia_raw.json"
    clean_json = work / "utt_clean.json"
    translations_py = work / "translations.py"

    # Step 1+2: 转写 + 去重 (除非 --build-only 或 utt_clean 已存在)
    if not args.build_only:
        if not clean_json.exists() or raw_json.exists():
            # step 1
            if not raw_json.exists():
                rc = run([sys.executable, str(SCRIPT_DIR / "gladia.py"),
                          str(args.audio), str(raw_json)]).returncode
                if rc != 0:
                    sys.exit(f"gladia.py failed (rc={rc})")
            else:
                print(f"[skip] {raw_json} exists")
            # step 2
            rc = run([sys.executable, str(SCRIPT_DIR / "dedup.py"),
                      str(raw_json), str(clean_json)]).returncode
            if rc != 0:
                sys.exit(f"dedup.py failed (rc={rc})")
        else:
            print(f"[skip] {clean_json} exists, 跳过转写+去重")

    if not clean_json.exists():
        sys.exit(f"missing {clean_json}, 请先跑转写+去重或 --build-only 前确认 utt_clean.json 在")

    # Step 3: 翻译模板 (空 dict, 用户填)
    if not args.skip_translation_template:
        import json as _json
        utts = _json.load(open(clean_json, encoding="utf-8"))
        n = len(utts)
        const = stem.upper().replace(".", "_")
        # 检查已有内容
        existing = None
        if translations_py.exists():
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location("t", translations_py)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                for name in dir(mod):
                    if name.startswith("TRANSLATIONS_") and isinstance(getattr(mod, name), dict):
                        existing = getattr(mod, name)
                        break
            except Exception as e:
                print(f"[warn] {translations_py} 解析失败: {e}", file=sys.stderr)
        if existing and any(v.strip() for v in existing.values()):
            print(f"[skip] {translations_py} 已有 {sum(1 for v in existing.values() if v.strip())} 条翻译")
        else:
            d = {str(i): "" for i in range(1, n + 1)}
            translations_py.write_text(
                f'"""{stem} EN→ZH 翻译映射（{n} 段）"""\nTRANSLATIONS_{const} = {d!r}\n',
                encoding="utf-8",
            )
            print(f"[gen ] {translations_py} ({n} 空段, 待用户填)")

    if not translations_py.exists():
        sys.exit(f"missing {translations_py}")

    # Step 4: 生成 SRT
    rc = run([sys.executable, str(SCRIPT_DIR / "build_srt_v2.py"),
              str(clean_json), str(translations_py), str(out_srt)]).returncode
    if rc != 0:
        sys.exit(f"build_srt_v2.py failed (rc={rc})")

    print(f"\n✓ DONE -> {out_srt}")
    print(f"  work dir: {work}")
    print(f"  clean: {clean_json}")
    print(f"  translations: {translations_py}")


if __name__ == "__main__":
    main()
