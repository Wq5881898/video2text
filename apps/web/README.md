# Web App

This directory contains the cloud web surface for `video2text`.

Production: [https://web-iota-one-31.vercel.app](https://web-iota-one-31.vercel.app)

As of September 22, 2026, this is a deployed product surface, not a future scaffold. The authoritative cross-product status is in [`../../docs/CURRENT_STATE_ZH.md`](../../docs/CURRENT_STATE_ZH.md).

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

Verified on September 22, 2026:

- `GET /api/health`
- `GET /api/capabilities`
- production health reports `ready`
- Blob, Gladia, and MiniMax configuration are present
- local Python tests: 35 passed
- web Node tests: 45 passed, including real FFmpeg splitting of a generated 12,309-second fixture

`/api/capabilities` is a basic environment probe. Its current `sync-direct` description does not enumerate the newer background-job, checkpoint, long-audio, and cleanup paths; this README and `CURRENT_STATE_ZH.md` are the complete product specification.

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

## Tests

```powershell
cd D:\projectQ\video2text\apps\web
node --test api/*.test.js
```

The default suite mocks paid provider calls. The real-FFmpeg long-audio test generates its own silent fixture and verifies split cleanup. Use `npm run test:cloud` only when intentionally testing deployed services and accepting remote API usage.

---

# Web 应用说明

这个目录是 `video2text` 的云端网页端。

生产地址：[https://web-iota-one-31.vercel.app](https://web-iota-one-31.vercel.app)

截至 2026-09-22，这已经是正式部署的产品入口，不再是未来骨架。跨桌面/Web 的权威状态见 [`../../docs/CURRENT_STATE_ZH.md`](../../docs/CURRENT_STATE_ZH.md)。

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

已在 2026 年 9 月 23 日验证：

- `GET /api/health`
- `GET /api/capabilities`
- 生产健康状态为 `ready`
- Blob、Gladia、MiniMax 环境配置存在
- Python 本地测试 35 项通过
- Web Node 测试 45 项通过，包含真实生成并切分 12,309 秒静音音频

`/api/capabilities` 目前是基础环境探针，其中的 `sync-direct` 摘要尚未完整列出后台任务、断点、长音频和清理路径；完整规格以本文及 `CURRENT_STATE_ZH.md` 为准。

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

## 测试

```powershell
cd D:\projectQ\video2text\apps\web
node --test api/*.test.js
```

默认测试会模拟付费服务调用；真实 FFmpeg 长音频测试自行生成静音样本并验证临时分段删除。只有明确接受远端 API 消耗时才运行 `npm run test:cloud`。

## 临时上传清理

- 同步任务或后台任务成功生成最终结果后，立即删除本应用上传到 Blob 的原始音频/视频。
- 删除失败不会把已完成任务改成失败；系统会记录延迟清理状态，保留结果供用户下载。
- 每次浏览器申请新的上传令牌时，顺带扫描并删除超过 48 小时的失败或遗留媒体，作为即时删除的兜底。
- 外部 URL 永远不会被删除；`jobs/.../status.json`、checkpoint 和 `result.json` 也不属于媒体清理范围。
- 当前实现不配置、不调用 Vercel Cron，也不再需要 `CRON_SECRET`。

## 超长录音

- 上传的音频或视频超过 8000 秒时，自动均分为小于上限的分段，逐段转写，最终生成原文件名对应的一个 TXT 或 SRT。
- TXT 按分段顺序合并；SRT 加上分段在原录音中的时间偏移，字幕编号连续。
- 分段任务 ID 和已完成的文字保存为断点，刷新任务页不会重新提交已完成的分段。任务页显示当前分段及已完成分段数。
- 切分文件仅存在于云函数临时目录，使用后删除，不额外写入 Blob。任务成功后立即删除原始上传文件；失败或遗漏文件由下一次上传触发的 48 小时清理兜底。
- 时长探测仅支持本项目 Blob 中的上传媒体。超长外部 URL 请先下载，再使用上传文件入口。
