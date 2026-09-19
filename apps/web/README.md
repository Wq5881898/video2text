# Web App

This directory contains the cloud web surface for `video2text`.

## Scope

- single-file browser upload
- single URL input
- synchronous short-recording requests and resumable background jobs
- optional English-to-Chinese translation
- inline result preview and client-side download

The cloud side is intentionally simple:

- one request in
- one transcript result out
- no batch task queue to manage
- no multi-task orchestration

## Boundaries

- desktop packaging does not depend on `apps/web`
- web deployment does not read from `release/`
- cloud-safe pipeline code lives under `apps/web/api`

## Entry Points

- static page: `apps/web/index.html`
- local helper server: `apps/web/dev_server.py`
- API endpoints:
  - `apps/web/api/blob-upload.js`
  - `apps/web/api/health.py`
  - `apps/web/api/capabilities.py`
  - `apps/web/api/transcribe.py`
  - `apps/web/api/media-info.js`
  - `apps/web/api/jobs-create.js`, `jobs-continue.js`, `jobs-status.js`, `jobs-result.js`

## Local Development

Run:

```powershell
cd D:\projectQ\video2text\apps\web
D:\projectQ\.venv\Scripts\python.exe dev_server.py
```

Open:

```text
http://127.0.0.1:3100/
```

## Runtime Behavior

- `Upload` mode sends the local file to Vercel Blob, checks its duration, then uses the sync API or one background job
- `URL` mode sends the remote media URL directly to `/api/transcribe`
- `txt` and `srt` are both supported
- optional Chinese translation uses MiniMax M3 when enabled
- short sync requests return one response; background jobs keep one persistent result URL

## Long Recordings

- Uploaded audio/video longer than 8,000 seconds is automatically split into balanced parts below the limit and processed serially in one background job.
- TXT output is merged in order; SRT timestamps include each part's original-recording offset. The output keeps the original filename stem.
- Paid transcription IDs and completed parts are checkpointed so page refreshes do not restart completed parts. Temporary chunks are removed from the function's local directory and never stored in Blob.
- Native duration probing is restricted to media in this project's Blob store. For oversize external URLs, download the file and use the upload entry.

## Production Status

Verified on July 27, 2026:

- `GET /api/health`
- `GET /api/capabilities`
- `POST /api/transcribe` with URL input
- `POST /api/transcribe` after Blob upload for large local files
- `txt` and `srt`
- optional Chinese translation

## Limits

- short sync requests can still hit execution limits; use Mobile mode for resumable background processing
- `dev_server.py` supports Python sync APIs only; use `vercel dev` for Node duration probing and background-job endpoints
- browser upload is handled through Vercel Blob to avoid direct request body limits
- this web app is for single-file cloud use, not batch processing
- larger or longer-running workloads should use the desktop app

## Required Environment Variables

- `GLADIA_API_KEY`
- `MINIMAX_API_KEY` (server-side only; never put this key in browser code)
- `MINIMAX_BASE_URL` and `MINIMAX_MODEL` are optional overrides
- `BLOB_READ_WRITE_TOKEN`

---

# Web 应用说明

这个目录是 `video2text` 的云端网页端。

## 功能范围

- 单文件浏览器上传
- 单个 URL 输入
- 短录音同步转写，可恢复的后台单文件任务
- 可选中译
- 页面内展示结果并直接下载

云端版本刻意保持简单：

- 一次提交一个文件
- 一次返回一个结果
- 不做需要用户管理的批量任务队列
- 不做复杂批处理

## 边界

- 桌面端打包不依赖 `apps/web`
- 网页端部署不读取 `release/`
- 云端可部署的核心逻辑放在 `apps/web/api`

## 入口

- 静态页面：`apps/web/index.html`
- 本地调试服务：`apps/web/dev_server.py`
- API：
  - `apps/web/api/blob-upload.js`
  - `apps/web/api/health.py`
  - `apps/web/api/capabilities.py`
  - `apps/web/api/transcribe.py`
  - `apps/web/api/media-info.js`
  - `apps/web/api/jobs-create.js`、`jobs-continue.js`、`jobs-status.js`、`jobs-result.js`

## 本地开发

运行：

```powershell
cd D:\projectQ\video2text\apps\web
D:\projectQ\.venv\Scripts\python.exe dev_server.py
```

打开：

```text
http://127.0.0.1:3100/
```

## 运行方式

- `Upload` 模式：上传到 Vercel Blob 后检查时长，短录音同步处理，超长录音自动转为一个后台任务
- `URL` 模式：直接把媒体 URL 发给 `/api/transcribe`
- 支持 `txt` 和 `srt`
- 勾选翻译时走 MiniMax M3 中译
- 同步请求一次返回结果；后台任务通过固定结果网址查询和下载

## 当前验证状态

已在 2026 年 7 月 27 日验证：

- `GET /api/health`
- `GET /api/capabilities`
- URL 模式转写成功
- 本地大文件先上传 Blob 再转写成功
- `txt` 和 `srt` 都可用
- 中译可用

## 当前限制

- 同步入口仍可能碰到执行时限；Mobile 模式使用可恢复的后台任务
- `dev_server.py` 仅支持 Python 同步接口；Node 时长检测与后台任务接口使用 `vercel dev` 调试
- 浏览器上传通过 Vercel Blob 规避请求体大小限制
- 这个网页端只针对单文件云端处理，不做批量任务
- 更大或更长的任务建议用桌面端

## 必要环境变量

- `GLADIA_API_KEY`
- `MINIMAX_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET`

## 临时上传清理

- 上传的音频和视频以 48 小时作为清理阈值，便于失败任务检查或重试。
- Vercel Cron 每天按 `15 4 * * *`（UTC）扫描并清理超过 48 小时的媒体 Blob；实际删除发生在下一次清理运行时，不是满 48 小时立即删除。Hobby 套餐的触发时间可能在对应小时内浮动。
- `jobs/.../status.json` 和 `result.json` 不属于媒体文件，不会被该任务删除。
- `CRON_SECRET` 用于验证只有 Vercel Cron 可以调用 `/api/blob-cleanup`。

## 超长录音

- 上传的音频或视频超过 8000 秒时，自动均分为小于上限的分段，逐段转写，最终生成原文件名对应的一个 TXT 或 SRT。
- TXT 按分段顺序合并；SRT 加上分段在原录音中的时间偏移，字幕编号连续。
- 分段任务 ID 和已完成的文字保存为断点，刷新任务页不会重新提交已完成的分段。任务页显示当前分段及已完成分段数。
- 切分文件仅存在于云函数临时目录，使用后删除，不额外写入 Blob。原始上传文件仍按 48 小时规则清理。
- 时长探测仅支持本项目 Blob 中的上传媒体。超长外部 URL 请先下载，再使用上传文件入口。
