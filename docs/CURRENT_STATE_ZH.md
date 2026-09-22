# video2text 当前开发状态

> 基线日期：2026-09-22  
> 作用：记录已经落地并由当前代码支持的功能。研究设想和未来计划不算作已完成功能。

## 1. 产品总览

仓库包含两个可用产品面：

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
| 文件保留 | 成功后删中间音频；失败保留 | 原始媒体最多约 48 小时；Cron 兜底清理 |
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

## 3. Web 端已完成

- 生产地址为 `https://web-iota-one-31.vercel.app`。
- 根页面提供互斥的本地上传/URL 输入。iOS Safari 自动重定向到 `/mobile`。
- 本地媒体由浏览器直接上传 Vercel Blob，绕过 Function 请求体大小限制。
- Mobile 模式创建后台任务并跳转到固定 `/jobs/<job_id>` 页面；刷新、关闭后重新打开仍可查询状态和结果。
- 短任务保留同步入口；长任务、Safari 和需要恢复的任务使用 Blob 中的状态/结果 checkpoint。
- 超过 8,000 秒的已上传媒体在云函数临时目录逐段切分、严格串行转写并合并。临时分段不写入 Blob。
- 并发继续请求使用条件写入，避免同一分段被重复付费提交。
- 翻译当前固定为 MiniMax M3；翻译工作分批推进、校验段 ID，并保存进度。
- 原始上传媒体的清理阈值为 48 小时。Vercel Cron 每天 `04:15 UTC` 调用清理接口；job 状态和结果受保护。
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
- `CRON_SECRET`

真实密钥不应进入 Git。桌面打包时配置会复制到发布目录，发布包必须按敏感文件保管。

## 5. 当前验证

2026-09-22 本地验证结果：

- Python `unittest`：32 项通过；
- Web Node tests：35 项通过；
- Node 测试包含真实生成 12,309 秒静音音频、切成两段、合并全局时间轴并删除临时分段；
- 生产 `/api/health` 返回 `status=ready`；
- 生产 `/api/capabilities` 检测 Blob、Gladia、MiniMax 已配置。
- GitHub `v0.1.0` 公开 API 已验证：标签指向提交 `23274a5`，ZIP 与 SHA256 两个资产均已公开且大小匹配。

这些测试不等于每次都执行真实付费转写。真实 Gladia/LLM smoke test 应单独运行并记录任务 ID。

## 6. 已知边界

- Web 仍受 Vercel Function、Blob Hobby 配额和 Cron 调度频率限制。
- Web 的 URL 模式不会对任意外部地址做本地时长探测；超长 URL 媒体应先下载后走上传入口。
- Web 只支持 MiniMax，尚未提供桌面端的 GLM/Qwen 选择。
- 桌面 CLI 暂未暴露源语言和翻译模型参数，使用默认 Auto + MiniMax；完整选择在 GUI。
- `outputs/work/run_all_win.py` 等历史批处理仍使用 DeepL。它们不是当前桌面 GUI/Web 产品翻译路径。
- Ubuntu + Cloudflare Tunnel + R2 是已归档预研方案，尚未实施。

## 7. 后续候选事项

- 继续观察 Vercel Blob 48 小时清理后的容量峰值和封停体验；
- 若迁移，按 R2 直传方案实现，不能让大文件经过 Cloudflare Tunnel；
- 如有产品需要，再把 GLM/Qwen 选择扩展到 Web；
- 更新 `/api/capabilities`，使其完整反映后台任务、长音频和清理能力；
- 为 GLM/Qwen 增加无密钥的示例配置文件。

以上均为候选事项，不应在完成代码、测试和部署前写成“已支持”。
