# video2text

中文：`video2text` 是一个本地优先的音视频转文字工具。它支持音频和视频输入，视频会先提取音频，再进行英文转写，可选翻译成中文，最后导出 `txt` 或 `srt`。

English: `video2text` is a local-first media-to-transcript tool for Windows. It accepts audio or video input, extracts audio from video, runs English speech-to-text, optionally translates to Chinese, and exports either `txt` or `srt`.

## 当前状态 | Current Status

- 中文：当前仓库已经整理为“一个仓库，两套产品，共享核心”。
- English: The repository is now organized as “one repo, two product surfaces, shared core”.

- `apps/desktop`
  - 中文：桌面客户端入口
  - English: desktop client entry
- `apps/web`
  - 中文：网页版骨架与后续部署入口
  - English: web scaffold and future deployment entry
- `packages/shared_core`
  - 中文：桌面端与网页端共用的核心流程
  - English: shared pipeline used by both desktop and web

兼容层仍然保留：

- `app/`
- `core/`

These remain as compatibility wrappers during migration.

## 功能概览 | Features

- 中文：支持单文件或批量处理。
- English: Supports single-file and batch processing.

- 中文：音频文件直接转写。
- English: Audio files are transcribed directly.

- 中文：视频文件先提取音频，再进入同一套转写流程。
- English: Video files first extract audio, then enter the same transcript pipeline.

- 中文：支持输出 `txt` 或 `srt`。
- English: Supports `txt` and `srt` output.

- 中文：支持“翻译为中文”开关。
- English: Supports an optional “translate to Chinese” switch.

- 中文：中间产物统一落到 job cache，便于复用和排障。
- English: Intermediate artifacts are stored in a job cache for reuse and debugging.

## 桌面客户端 | Desktop App

启动方式：

```powershell
run_gui.bat
```

或者：

```powershell
D:\projectQ\.venv\Scripts\python.exe apps\desktop\main.py
```

当前桌面端已具备：

- 中文：拖拽文件和文件夹
- English: drag and drop files or folders

- 中文：批量队列处理
- English: batch queue processing

- 中文：输出格式选择 `txt` / `srt`
- English: output format selection `txt` / `srt`

- 中文：翻译开关
- English: translation toggle

- 中文：输出目录自动跟随输入目录，支持手动修改
- English: output folder auto-follows the input folder, with manual override

- 中文：预设保存/加载
- English: preset save/load

- 中文：队列状态恢复
- English: queue restore

- 中文：环境检查
- English: environment check

- 中文：进度条和逐文件状态显示
- English: progress bar and per-file status display

- 中文：运行日志
- English: runtime log

- 中文：最近输出列表
- English: recent outputs list

- 中文：任务详情面板
- English: task details panel

- 中文：Job Cache / Recent Outputs / Task Details 已整理为标签页
- English: Job Cache / Recent Outputs / Task Details are grouped into tabs

- 中文：低频菜单已收纳进 `Other`
- English: low-frequency actions are grouped under `Other`

- 中文：新增 `Cleanup Cache`，用于清理全部中间产物
- English: added `Cleanup Cache` to remove all intermediate artifacts

## Cleanup Cache 说明 | What Cleanup Cache Removes

`Cleanup Cache` 会删除：

- `outputs/work/jobs/` 下所有 job 文件夹
- 视频提取产生的中间音频
- `gladia_raw.job_id`
- `gladia_raw.json`
- `utt_clean.json`
- `gladia_zh.json`
- GUI 队列状态与运行状态文件
- 默认导出的 runtime log

`Cleanup Cache` 不会删除：

- 最终输出的 `txt`
- 最终输出的 `srt`
- `config` 下的 key 文件
- 手动保存的 preset

## 输入与输出规则 | Input and Output Rules

音频输入支持：

- `.m4a`
- `.mp3`
- `.wav`
- `.aac`
- `.flac`
- `.ogg`
- `.wma`
- `.m4b`

视频输入支持：

- `.mp4`
- `.mov`
- `.mkv`
- `.avi`
- `.wmv`
- `.flv`
- `.webm`
- `.m4v`

视频提取规则：

- 中文：单声道直接拷贝
- English: mono audio is copied directly

- 中文：双声道或多声道取左声道，转为单声道 AAC
- English: stereo or multi-channel audio keeps the left channel and encodes to mono AAC

输出规则：

- `txt`
  - 中文：不翻译时输出英文文本
  - English: English transcript when translation is off
  - 中文：翻译开启时输出中英双语文本，中文在前，英文在后
  - English: bilingual text when translation is on, Chinese first and English second

- `srt`
  - 中文：不翻译时输出英文字幕
  - English: English subtitle when translation is off
  - 中文：翻译开启时输出中英双语字幕，中文在前，英文在后
  - English: bilingual subtitle when translation is on, Chinese first and English second

## 目录结构 | Repository Structure

```text
video2text/
  apps/
    desktop/
    web/
  packages/
    shared_core/
  app/        # compatibility wrapper
  core/       # compatibility wrapper
  config/
  outputs/
  scripts/
```

关键文件：

- [`apps/desktop/main.py`](D:/projectQ/video2text/apps/desktop/main.py)
- [`packages/shared_core/media_pipeline.py`](D:/projectQ/video2text/packages/shared_core/media_pipeline.py)
- [`outputs/work/product_pipeline.py`](D:/projectQ/video2text/outputs/work/product_pipeline.py)
- [`scripts/desktop/build_release.ps1`](D:/projectQ/video2text/scripts/desktop/build_release.ps1)

## 首次配置 | First-Time Setup

1. 复制 [`config/gladia_keys.example.txt`](D:/projectQ/video2text/config/gladia_keys.example.txt) 为 `config/gladia_keys.txt`
2. 在 `config/gladia_keys.txt` 中每行放一个 Gladia key
3. 复制 [`config/deepl_key.example.txt`](D:/projectQ/video2text/config/deepl_key.example.txt) 为 `config/deepl_key.txt`
4. 在 `config/deepl_key.txt` 中填入 DeepL Free API key
5. 保证 `ffmpeg` / `ffprobe` 可用，或安装在 `D:\program\ffmpeg\bin\`

The desktop app checks these requirements automatically.

## 命令行入口 | CLI Entry

```powershell
python outputs\work\product_pipeline.py <files...> --format txt
python outputs\work\product_pipeline.py <files...> --format srt
python outputs\work\product_pipeline.py <files...> --format srt --translate
```

示例：

```powershell
python outputs\work\product_pipeline.py D:\DownloadTest\demo.m4a --format txt
python outputs\work\product_pipeline.py D:\DownloadTest\clip.mp4 --format srt --translate
python outputs\work\product_pipeline.py D:\media\*.mp4 --format txt --translate --output-dir D:\media\exports
```

## 打包发布 | Windows Release

桌面版使用 `PyInstaller` 打包。

The packaged Windows release bundles `ffmpeg.exe` and `ffprobe.exe`, so end users do not need to install ffmpeg separately.

构建命令：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_release.ps1
```

发布目录：

```text
release\video2text\
```

配置文件位置：

```text
release\video2text\video2text\config\
```

## 网页版方向 | Web Direction

- 中文：网页版与桌面版共用 `shared_core` 思路，但部署时会保持边界清晰。
- English: The web app shares the `shared_core` direction with the desktop app, while keeping packaging and deployment boundaries clear.

- 中文：桌面端优先解决本地处理和打包问题。
- English: The desktop client is prioritized for local processing and packaging first.

- 中文：网页端后续用于在线入口和 Vercel 部署。
- English: The web app is reserved for the online entry and future Vercel deployment.
