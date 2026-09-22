# video2text

`video2text` 是一个音视频转文字产品，包含 Windows 桌面客户端和已部署的单文件 Web 端。两端都使用 Gladia 转写，支持 `txt` / `srt`，并可把英文转录翻译成简体中文。

`video2text` is a media-to-transcript product with a Windows desktop client and a deployed single-file web app. Both surfaces use Gladia for transcription, export `txt` or `srt`, and can translate English transcripts into Simplified Chinese.

## 当前状态 | Current Status

- 桌面端：本地队列、批量处理、API Key 管理、MiniMax / GLM / Qwen 流式翻译、长音频自动切分。
- Desktop: local batch queue, API key management, streaming MiniMax / GLM / Qwen translation, and automatic long-audio splitting.
- Web 端：Vercel 生产部署，单文件或单 URL、Safari/mobile 后台任务、固定 Job URL、长音频断点续跑。
- Web: production Vercel deployment with one file or URL per task, Safari/mobile background jobs, persistent job URLs, and resumable long-audio processing.
- 当前生产 Web 地址：[https://web-iota-one-31.vercel.app](https://web-iota-one-31.vercel.app)
- 权威开发状态见 [`docs/CURRENT_STATE_ZH.md`](docs/CURRENT_STATE_ZH.md)。

## 产品边界 | Product Boundaries

```text
video2text/
  apps/desktop/          Windows PyQt6 client
  apps/web/              Vercel web product and cloud APIs
  packages/shared_core/  Desktop/CLI reusable pipeline
  outputs/work/          Pipeline helpers and legacy batch scripts
  scripts/desktop/       Windows release build and smoke tests
  docs/                  Architecture, deployment and research notes
```

`apps/web` 使用适合 serverless 的独立云端实现，不直接打包桌面端的 PyQt、缓存目录或 EXE 资源。`app/` 和 `core/` 仅作为迁移期兼容层。

The web app has a serverless-safe implementation under `apps/web/api`; it does not package desktop UI or release artifacts. `app/` and `core/` remain compatibility wrappers.

## 桌面客户端 | Desktop App

从仓库根目录启动：

```powershell
D:\projectQ\video2text\run_gui.bat
```

也可以直接启动 Python 入口：

```powershell
cd D:\projectQ\video2text
D:\projectQ\.venv\Scripts\python.exe apps\desktop\main.py
```

主要能力：

- 拖拽文件/文件夹、批量队列、失败重试和队列恢复；
- 自动检测、英文、中文、中英混合四种源语言模式；
- `txt` / `srt` 输出，默认输出到输入文件目录，也可指定目录；
- 英文中译可选择 MiniMax M3、GLM 或 Qwen；默认 MiniMax M3；
- 三个模型都使用流式响应，翻译批次串行执行，逐批原子保存缓存；
- 超过 8,000 秒的媒体自动均分，逐段串行转写，再合并为一个完整结果；
- API Key Management 可维护多个 Gladia Key 和三个翻译模型的配置；
- 成功后删除视频提取音轨和长音频分段；失败时保留中间音频与断点供重试；
- `Cleanup Cache` 清理 job、音频、转录缓存、队列状态和日志，但保留最终 `txt` / `srt`、Key 与 preset。

Translation is available only for English transcripts (`English` or English detected in `Auto`). Chinese and mixed-language modes preserve their source transcript.

### 桌面配置 | Desktop Configuration

推荐从工具栏打开 `API Key Management` 配置：

- Gladia：`config/gladia_keys.txt`，每行一个 Key；
- MiniMax：`config/minimax.json`；
- GLM：`config/glm.json`；
- Qwen：`config/qwen.json`。

每个翻译配置包含 `base_url`、`api_key` 和 `model`。同名环境变量 `*_BASE_URL`、`*_API_KEY`、`*_MODEL` 优先于 JSON。真实配置被 `.gitignore` 排除，不应提交到 GitHub。

Python 版的应用根目录是仓库根目录；EXE 版的应用根目录是 `video2text.exe` 所在目录。因此两者分别读取各自根目录下的 `config/`，缓存也分别位于各自根目录的 `outputs/work/jobs/`。

## 长音频 | Long Audio

Gladia 单次媒体时长上限约为 8,100 秒，产品采用 8,000 秒安全线：

1. 使用 `ffprobe` 读取真实媒体时长；
2. 超过 8,000 秒时均衡规划分段；
3. 使用 `ffmpeg` 生成临时音频段；
4. 严格串行提交 Gladia，保存每段 job ID 和结果；
5. TXT 按顺序合并，SRT 恢复到原录音全局时间轴；
6. 最终结果成功后删除临时音频；失败时保留以便继续。

重试会复用已完成段和仍在等待的远端任务，避免重复付费提交。原始音频和视频永远不会被自动删除。

## Web 应用 | Web App

Web 端刻意保持“一次输入、一个结果”，不提供桌面端式批量队列：

- 上传本地文件和输入媒体 URL 自动互斥；
- 浏览器直接上传 Vercel Blob，媒体不经过 Vercel Function 请求体；
- iOS Safari 访问根地址时自动进入 `/mobile` 后台任务模式；
- 每个后台任务获得固定 `/jobs/<job_id>` 地址，刷新或稍后打开不会丢失任务；
- 长音频自动切分并断点保存，已完成分段不会重新提交；
- Web 翻译当前固定使用 MiniMax M3；
- 媒体 Blob 保留阈值为 48 小时，由 Vercel Cron 每天清理；job 状态和结果不属于该媒体清理范围。

Web 详细说明见 [`apps/web/README.md`](apps/web/README.md)。Ubuntu + Cloudflare Tunnel + R2 仍只是备选预研，见 [`docs/CLOUD_STORAGE_ALTERNATIVE_ZH.md`](docs/CLOUD_STORAGE_ALTERNATIVE_ZH.md)。

## 输入输出 | Input And Output

支持音频：`.m4a`、`.mp3`、`.wav`、`.aac`、`.flac`、`.ogg`、`.wma`、`.m4b`。

支持视频：`.mp4`、`.mov`、`.mkv`、`.avi`、`.wmv`、`.flv`、`.webm`、`.m4v`。

视频中的单声道音轨直接复制；双声道或多声道取左声道并转为单声道 AAC。未翻译输出保留源语言；翻译输出为中文在前、英文在后的双语 TXT/SRT。

## 命令行 | CLI

```powershell
python outputs\work\product_pipeline.py <files-or-folders...> --format txt
python outputs\work\product_pipeline.py <files-or-folders...> --format srt --translate
python outputs\work\product_pipeline.py D:\media --format srt --translate --output-dir D:\media\exports
```

CLI 当前使用 `Auto Detect` 和默认 MiniMax；源语言与翻译模型的可视化选择在桌面客户端中提供。

## Windows 打包 | Windows Release

```powershell
cd D:\projectQ\video2text
powershell -ExecutionPolicy Bypass -File scripts\desktop\build_release.ps1
```

发布目录：

```text
release\video2text\video2text\
```

发布包包含 `ffmpeg.exe` / `ffprobe.exe`，构建后会自动执行模块、DLL、统一配置路径、去重、12,309 秒音频真实切分/合并和拖拽初始化 smoke test。不要只复制 EXE；必须保留同级 `_internal/`、`config/` 和 `outputs/`。

## Web 本地开发与部署 | Web Development And Deploy

```powershell
cd D:\projectQ\video2text\apps\web
npm install
npm run build
vercel dev
```

生产部署：

```powershell
npm run build
vercel --prod
```

部署和环境变量详见 [`docs/PACKAGING_AND_DEPLOY.md`](docs/PACKAGING_AND_DEPLOY.md)。

## 测试 | Tests

```powershell
D:\projectQ\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
cd apps\web
node --test api/*.test.js
```

真实云端 smoke test 和 Gladia 调用可能消耗远端配额，不属于默认单元测试。

## 相关文档 | Documentation

- [`docs/CURRENT_STATE_ZH.md`](docs/CURRENT_STATE_ZH.md)：当前实现、已验证状态和已知边界
- [`docs/PACKAGING_AND_DEPLOY.md`](docs/PACKAGING_AND_DEPLOY.md)：打包、部署与验证
- [`docs/REPO_BOUNDARIES.md`](docs/REPO_BOUNDARIES.md)：代码与运行时边界
- [`docs/LONG_TEXT_TRANSLATION_BENCHMARK_ZH.md`](docs/LONG_TEXT_TRANSLATION_BENCHMARK_ZH.md)：三模型测试及当前落地决策
- [`docs/CLOUD_STORAGE_ALTERNATIVE_ZH.md`](docs/CLOUD_STORAGE_ALTERNATIVE_ZH.md)：R2 自托管备选预研
