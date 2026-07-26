# Project Rules — Audio Bilingual Subtitle Pipeline

> 任何 session 在 outputs/ 下启动时必读。完整 SOP 在同目录 `WORKFLOW.md`, 本文件是**铁律 + 坑点速查**, 用于避开已踩过的坑。
>
> **当前架构 (2026-07 改)**: Gladia en-only stt + DeepL Free en→zh 翻译 + `run_all_win.py auto` 零干预流水线。旧 `gladia_with_translation.py` 走 Gladia translation 池已废弃 (quota 触顶, 见坑 AJ).
>
> **流程图**: 见 `WORKFLOW.md` 第 0 节 Mermaid 流程图 (主流程 + 旧架构对比)。

---

## 0. 命名铁律 (违反 = 用户立刻发现)

1. **SRT 文件名 = 音频文件名, 无任何后缀** (无 `_中英字幕` / `_zh` / `_bilingual`)
2. **SRT 输出目录 = 音频所在目录** (默认 `D:\DownloadTest\`, 不是 `outputs/`)
3. 例子: `D:\DownloadTest\250912.m4a` → `D:\DownloadTest\250912.srt`
4. 早期 `outputs/250824_中英字幕.srt` 等保留不动 (历史命名)
5. `outputs/<期号>.srt` 只作备份副本

---

## 1. 多期批量唯一可靠模式 (坑 U 修复)

bash 工具 45 秒超时, Gladia 5-10 分钟, **不能用 nohup/setsid**。当前**生产入口改 Windows 原生** `run_all_win.py auto` (不经过 WSL/bwrap), 一次跑 30 分钟自轮询。**多期旧模式** submit_only + fetch_done 仍可用, 但已非主推路径。

```bash
# ⭐ 主推: Windows 原生一键流水线
run_pipeline.bat
# 内部: cd outputs\work && python run_all_win.py auto
# 30 分钟内能跑多少跑多少, 状态机续接, 重跑不浪费 quota
```

```bash
# 备选: Linux/VM 端 (路径硬编码的 run_all.py)
python3 run_all.py auto <tag1> <tag2> ...
```

```bash
# 备选: 旧 submit_only + fetch_done (bash 受 45s 限制时用)
python3 submit_only.py <tag1> <tag2> <tag3>  # 一次 2-3 个
# 等 2-3 分钟
python3 fetch_done.py <tag1> ... <tag6>      # 一次 6 个
# dedup
for d in <tags>; do python3 dedup.py $d/gladia_raw.json $d/utt_clean.json; done
# DeepL 翻译 (新) / 用户填 translations.py (旧, LLM 翻)
python3 deepl_translate.py <tag>              # 新流水线用这个
# 出 SRT
for d in <tags>; do python3 pipeline.py /path/to/$d.m4a --work-dir $d --build-only; done
```

---

## 2. 已踩坑点速查 (本目录工作最相关的)

| 坑 | 一句话 | 修复 |
|----|--------|------|
| **U** | bwrap sandbox 跨 bash 调用必杀进程 | submit_only + fetch_done |
| **V** | `from gladia import upload` 后 SRC 还是默认路径 | 调 `upload(rotator, src=audio)` |
| **W** | `rm __pycache__/*.pyc` 被拒 | `open(p,'wb').write(b'')` 清空字节 |
| **X** | Edit 大文件末尾截断, Read 显示旧 state | 改完用 `ast.parse(open(f).read())` 验证 |
| **B** | `__pycache__` 删不掉但代码改了不生效 | touch mtime 或清空 pyc 字节 |
| **C** | Write 工具偶尔追加 NUL 字节 | build_srt_v2.py 自动 strip; 写文件用 bash heredoc |
| **D** | Edit 改动不生效 (linter 干扰) | bash heredoc 整文件重写 |
| **R** | Subagent Write 大 dict 文件未生效 | main agent 自己用 bash heredoc |
| **S** | 正则匹 TRANSLATIONS dict 失败 | `ast.parse` + `ast.literal_eval` |
| **T** | DownloadTest mount 缓存诡异 | 不删旧文件, 只写新路径 |
| **AG** | `run_all_state.json` 写一半被砍, JSON 解析失败 | `load_state()` 带 JSONDecodeError 容错, 自动备份 `.json.bad` 用空 state |
| **AH** | bwrap `--die-with-parent` 杀 detached python | Windows 原生 `run_all_win.py` 直接跑 |
| **AI** | multi-host mount 不同步: WSL/Linux VM 写的 state.json 看不到 Windows 端写的, 反之亦然 | auto 进程只跑在单端 (Windows 原生), 别在 Linux VM 端同时跑 auto |
| **AJ** | Gladia translation 池月底触发 quota 触顶 | en-only stt + DeepL Free 翻译代替 |
| **AK** | `pipeline.py` 不传 `--build-only` 也对, 但加 `--build-only` 后不删 zh 缓存 | 改为跑 `dedup.py + deepl_translate.py + build_srt_from_gladia_zh.py` 三段式 |
| **AL** | Gladia `audio_url` 跟上传它的 key 绑定 (换 key 就 401) | `transcribe` 401/403 抛 `AudioUrlKeyMismatch`, 上传阶段已绑定 key 才能读 |
| **AM** | Edit 大文件末尾截断 (坑 X 再发) | 整文件 heredoc 重写 |
| **AN** | state=built 但磁盘 SRT 缺失 → 不重跑 | `sync_state_with_disk` 自动 reset pending |
| **AO** | dedup Round 5 把 dur>0.8s 的真人短语也合并了 | 加 duration 护栏 `< 0.8s` |
| **AP** | cmd_status 自动遍历 state 全集, one TAG 模式只显示该 TAG | 默认按 TAG 过滤 |
| **AQ** | per-tag key 预检 × N tag = 重复探测废 key | 启动一次性预检, mark_bad 跳过废 key |
| **AR** | cmd_dedup race 时 fetch 还没生成 gladia_zh.json → FileNotFoundError | stage_dedup silent skip (zh_path 不存在就 return) |
| **AS** | dedup Round 3 "drop <3 words" 把真人短语 (I mean, God examples) 删掉 | 完全重写 dedup.py: 8-round 流水线, **只去重 + 合并, 不删任何段, conf<0.4 加 \`*\`** |
| **AT** | deepl_translate 缓存 key 用 `(start, end, text)` 三元组, 新版 dedup 加 `*` 后 text 变 → cache 命中错位, zh 文件丢段 | 重跑前先 backup 旧 `gladia_zh.json` 为 `.bad`, 让 deepl 走全翻译模式 |
| **AU** | state=pending 但磁盘有 `<tag>/gladia_raw.job_id`, cmd_fetch 跳过 → 永久 pending 死锁 | `sync_state_with_disk` 检测 orphan job_id 自动恢复到 submitted |
| **AV** | `sync_state_with_disk` 把 `fetched/deduped/translated` 强制 reset pending 太激进 → 跟 AU 一起死锁 | 同时检查 `gladia_raw.job_id` 存在就不 reset, 改为恢复 submitted |
| **AW** | bash 工具 45s 硬上限, deepl_translate 一次性翻译 283 段会被砍, 不写 zh.json | 用 `deepl_translate_one_batch.py <utt> <out> <idx>` 单 batch 翻译, 串行 6 次每次 ~1s, 然后装配 zh.json |
| **AX** | `stage_dedup` 旧版幂等检查比对 `len(zh.segments_en) == len(utt_clean)`, 旧版 zh.json (271 段) 跟旧版 utt_clean (271 段) 对齐 → 永久跳过 dedup, 永远跑不到新 dedup → SRT 缺短段 (160802 缺 "It's fun, it's bright,") | 强制重跑: 不比对 zh 段数, 一律 rename utt_clean 为 `.pre_rededup` 后跑新 dedup; dedup 开销 <1s |
| **AY** | `run_zh_pipeline.py` 内部嵌一份 `dedup_en()` 函数 (Round 3 过杀 <3 词逻辑), `stage_dedup`/`build_srt` 默默调它, 流水线从来不走外部 `dedup.py` → 之前所有 dedup 修复 (坑 AS/AO/AO) 实际从未生效, SRT 持续丢短段 | **删除** 内嵌 `dedup_en()` 函数 (整个 dedup_en 块), 替换为 stub 抛 `RuntimeError` 防止误用; `stage_dedup` 改 `subprocess.run([sys.executable, "-B", "-u", "dedup.py", raw, uc_path])` 强制走外部 `dedup.py` (single source of truth); `build_srt` 直接读 `utt_clean.json`, 不再 fallback 调 dedup_en. 验证: 跑 `stage_dedup('160802')` 输出 283 段含 "It's fun, it's bright," |
