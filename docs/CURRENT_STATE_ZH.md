# video2text 当前开发状态

> 基线日期：2026-09-27
> 作用：记录已经落地并由当前代码支持的功能。研究设想和未来计划不算作已完成功能。

## 1. 产品总览

仓库包含 Windows、独立 Vercel 与独立 Docker 三个产品面。下表为桌面/Vercel 对照，Docker 状态单列于后文：

Windows `v0.1.0` 已发布到 [GitHub Releases](https://github.com/Wq5881898/video2text/releases/tag/v0.1.0)。公开 ZIP 保留完整 one-folder 目录，但不包含任何 API Key。

| 能力 | Windows 桌面端 | Vercel Web 端 |
|---|---|---|
| 输入 | 多文件、文件夹、拖拽队列 | 单文件或单 URL |
| 输出 | TXT / SRT | TXT / SRT |
| 源语言 | Auto、English、Chinese、English + Chinese | 当前云端主流程为英文转录 |
| 中译模型 | MiniMax M3、GLM、Qwen，可选择 | MiniMax M3 |
| 翻译传输 | 流式、串行批次、逐批缓存 | 可恢复后台批次 |
| 长音频 | 超过 8,000 秒本地切分 | 超过 8,000 秒云端临时切分 |
| 任务恢复 | 本地 job cache | Blob checkpoint + 固定 Job URL |
| 文件保留 | 成功后删中间音频；失败保留 | 成功后立即删原始媒体；新上传时清理超过 48 小时的遗留媒体 |
| 批量处理 | 支持 | 不支持，产品设计为单任务 |

## 2. 桌面端已完成

- `apps/desktop/main.py` 是实际 PyQt6 产品入口，不再由旧 `app/main.py` 提供实现。
- 文件/文件夹选择、拖拽、队列状态、失败重试、恢复队列、preset、日志、最近输出和任务详情均已实现。
- `API Key Management` 位于主工具栏，可维护多个 Gladia Key，以及 MiniMax、GLM、Qwen 三套翻译配置。
- Gladia Key 检测根据当前月可见任务时长估算免费用量；它不是官方账户余额。翻译模型检测验证连接和模型，不提供余额。
- 源语言支持自动、英文、中文和中英混合。只有英文或自动识别为纯英文时才执行中译。
- 默认翻译模型为 MiniMax M3；GLM 和 Qwen 可在界面选择。
- 三个模型共用流式 OpenAI-compatible 调用；单批最多 40 段、约 12,000 字符，严格串行。格式错误会重试并递归缩小批次，成功批次原子写入缓存。
- 视频先提取音轨。超过 8,000 秒的媒体均衡切分并逐段串行转写，最终合并为一个与原文件同名的 TXT/SRT。
- 保存 Gladia job ID、提交 Key 指纹、分段结果和翻译缓存。超时后可以继续，远端终态失败在下一次人工重试时重新提交。
- 成功输出后删除视频提取音轨和切分音频；渲染或转写失败则保留，便于闭环重试。
- Python 和 EXE 使用相同的相对目录约定，但应用根不同。Python 根是仓库；EXE 根是可执行文件目录。
- 打包脚本处理了 PyInstaller 模块收集、Qt/VC runtime 与 ICU 冲突、内置 ffmpeg/ffprobe，并在构建后自动运行 smoke tests。

## 3. Vercel Web 端（独立、保持不变的回滚产品）

- 生产地址为 `https://web-iota-one-31.vercel.app`。
- 根页面提供互斥的本地上传/URL 输入。iOS Safari 自动重定向到 `/mobile`。
- 本地媒体由浏览器直接上传 Vercel Blob，绕过 Function 请求体大小限制。
- Mobile 模式创建后台任务并跳转到固定 `/jobs/<job_id>` 页面；刷新、关闭后重新打开仍可查询状态和结果。
- 短任务保留同步入口；长任务、Safari 和需要恢复的任务使用 Blob 中的状态/结果 checkpoint。
- 超过 8,000 秒的已上传媒体在云函数临时目录逐段切分、严格串行转写并合并。临时分段不写入 Blob。
- 并发继续请求使用条件写入，避免同一分段被重复付费提交。
- 翻译当前固定为 MiniMax M3；翻译工作分批推进、校验段 ID，并保存进度。
- 同步和后台任务成功生成最终结果后，立即删除本应用上传的原始媒体。每次新上传前再清理超过 48 小时的失败或遗留媒体；不依赖 Vercel Cron。外部 URL、job 状态、checkpoint 和结果受保护。
- `/api/health` 和 `/api/capabilities` 已于 2026-09-22 在线验证。`capabilities` 是基础环境探针，尚未完整枚举后台任务与长音频能力，不能替代本文件。

## 4. 当前配置

桌面端：

- `config/gladia_keys.txt`
- `config/minimax.json`
- `config/glm.json`
- `config/qwen.json`

Web 端生产环境：

- `GLADIA_API_KEY`
- `MINIMAX_API_KEY`
- `MINIMAX_BASE_URL`、`MINIMAX_MODEL`（可选覆盖）
- `BLOB_READ_WRITE_TOKEN`

真实密钥不应进入 Git。桌面打包时配置会复制到发布目录，发布包必须按敏感文件保管。

## 5. 独立 Docker V3 当前部署

截至 2026-09-27，Docker 已部署，不再是“尚未部署的 NAS 预览版”。

- `https://stt.151077.xyz`：独立网页、上传票据、任务控制与结果查询。
- `https://upload.151077.xyz`：tus 断点上传、供 Gladia 拉取的短期签名媒体读取。
- 只接受本地文件上传，不支持 URL 输入；Gladia 使用签名 URL 拉取是内部数据流，不是用户 URL 输入功能。
- Caddy 对外提供 80/443；`127.0.0.1:8081` 仅供现有 Sub2API allowlist；Cloudflare Tunnel 保持不变。worker/tusd 无宿主机端口发布。
- Vercel 作为独立回滚产品原样保留，不参与 Docker 控制链路；standalone 不需要 `NAS_PREVIEW_*` 环境变量。
- 源码 `/opt/video2text`，数据 `/srv/app-data/video2text`，私有配置 `/srv/video2text-config`；文档更新不代表变更磁盘、密钥或部署。

### 生命周期

| 数据 | 当前策略 |
|---|---|
| 成功媒体、分段及 work | 最终结果和任务完成记录持久化后立即删除 |
| 失败/部分完成媒体 | 7 天兜底保留与清理，支持故障排查/恢复 |
| 未完成上传 | 24 小时回收 |
| 容量保护 | 高水位 80%，不得误删运行中任务或持久结果 |
| TXT/SRT、任务记录 | 长期保留，不随媒体清理删除 |

### Provider 与验证边界

- MiniMax：已验证；启用 provider 的环境配置仅为 `minimax`。
- Qwen：调用出现 HTTP 403，当前禁用；配置存在或模型列表可读不代表翻译可用。
- GLM：未配置，不可标为已验证或可用。
- 不在本文件保留过时的精确测试数量。最新测试、构建和公网/E2E 证据应以对应代码版本的验收记录为准；本文不声称重新运行了这些验证。
- 云端付费转写必须单独授权并记录脱敏证据；不得把配置读取成功当成端到端成功。
- Basic Auth 仍是现有认证边界。Cookie session 仅为设计，见 [`DOCKER_SESSION_AUTH_PLAN_ZH.md`](DOCKER_SESSION_AUTH_PLAN_ZH.md)。

## 6. 已知边界

- Web 仍受 Vercel Function 和 Blob Hobby 配额限制；当前清理只在任务成功或用户开始新上传时运行，不提供独立定时清理。
- Web 的 URL 模式不会对任意外部地址做本地时长探测；超长 URL 媒体应先下载后走上传入口。
- Web 只支持 MiniMax，尚未提供桌面端的 GLM/Qwen 选择。
- 桌面 CLI 暂未暴露源语言和翻译模型参数，使用默认 Auto + MiniMax；完整选择在 GUI。
- `outputs/work/run_all_win.py` 等历史批处理仍使用 DeepL。它们不是当前桌面 GUI/Web 产品翻译路径。
- Docker 已部署不等于所有浏览器、大文件和长音频组合均已验收；未有证据的矩阵项不得标为通过。历史 NAS 方案及实际偏差见 `NAS_MEDIA_STORAGE_PLAN_ZH.md`。
- Ubuntu + Cloudflare Tunnel + R2 是另一份备选预研方案，尚未实施。

## 7. 后续候选事项（非已完成）

- 按实际版本补充自动化测试、浏览器并发、公网路由、生命周期及长音频恢复证据。
- 仅在真实调用验证通过后重新考虑启用 Qwen；GLM 先完成配置和验证。
- 评审 Cookie session 认证设计，后续另行授权实施、无中断迁移与回滚测试。
- Vercel 的能力探针与功能扩展属于独立产品工作，不作为 Docker 部署前置条件。
