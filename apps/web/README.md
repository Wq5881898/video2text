# Web App

This directory contains the cloud web surface for `video2text`.

## Scope

- single-file browser upload
- single URL input
- synchronous transcription request
- optional English-to-Chinese translation
- inline result preview and client-side download

The cloud side is intentionally simple:

- one request in
- one transcript result out
- no background job queue
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

- `Upload` mode sends the local file to Vercel Blob first, then calls `/api/transcribe` with the Blob URL
- `URL` mode sends the remote media URL directly to `/api/transcribe`
- `txt` and `srt` are both supported
- optional Chinese translation uses DeepL when enabled
- the browser receives the final transcript in one response and downloads it locally

## Production Status

Verified on July 27, 2026:

- `GET /api/health`
- `GET /api/capabilities`
- `POST /api/transcribe` with URL input
- `POST /api/transcribe` after Blob upload for large local files
- `txt` and `srt`
- optional Chinese translation

## Limits

- processing is synchronous, so long media can still hit Vercel execution limits
- browser upload is handled through Vercel Blob to avoid direct request body limits
- this web app is for single-file cloud use, not batch processing
- larger or longer-running workloads should use the desktop app

## Required Environment Variables

- `GLADIA_API_KEY`
- `DEEPL_KEY`
- `BLOB_READ_WRITE_TOKEN`

---

# Web 应用说明

这个目录是 `video2text` 的云端网页端。

## 功能范围

- 单文件浏览器上传
- 单个 URL 输入
- 同步转写
- 可选中译
- 页面内展示结果并直接下载

云端版本刻意保持简单：

- 一次提交一个文件
- 一次返回一个结果
- 不做后台任务队列
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

- `Upload` 模式：先把本地文件上传到 Vercel Blob，再把 Blob URL 交给 `/api/transcribe`
- `URL` 模式：直接把媒体 URL 发给 `/api/transcribe`
- 支持 `txt` 和 `srt`
- 勾选翻译时走 DeepL 中译
- 浏览器一次性拿到最终结果，并在前端下载

## 当前验证状态

已在 2026 年 7 月 27 日验证：

- `GET /api/health`
- `GET /api/capabilities`
- URL 模式转写成功
- 本地大文件先上传 Blob 再转写成功
- `txt` 和 `srt` 都可用
- 中译可用

## 当前限制

- 云端处理是同步的，较长音频仍可能碰到 Vercel 执行时限
- 浏览器上传通过 Vercel Blob 规避请求体大小限制
- 这个网页端只针对单文件云端处理，不做批量任务
- 更大或更长的任务建议用桌面端

## 必要环境变量

- `GLADIA_API_KEY`
- `DEEPL_KEY`
- `BLOB_READ_WRITE_TOKEN`
