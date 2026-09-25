# NAS 媒体存储迁移方案（长期任务）

> 状态：可行性方案，尚未实施
> 建档日期：2026-09-23
> 技术选型复核：2026-09-25
> 原则：先完成并验证 Vercel Blob 的短期止损，再单独实施 NAS 迁移；未通过端到端测试前不替换现有生产入口。

## 1. 目标与阶段划分

当前浏览器先把媒体上传到 Vercel Blob，再由云端提交给 Gladia。该结构能支持 Safari 和后台任务，但会占用 Vercel Blob 配额，清理失效时可能导致整个存储被 Hobby 套餐封停。

工作分成两个阶段：

1. **短期止损（当前代码已实现）**：任务成功生成最终结果后立即删除原始上传媒体；每次开始新上传时清理超过 48 小时的失败或遗留媒体；取消 Vercel Cron。
2. **长期迁移（本文范围）**：浏览器把文件直接上传到用户 NAS；Vercel 只保存对象编号、短期读取 URL、任务状态和文字结果，不再保存音频或视频。

## 2. 可行性结论

可行。Gladia 的预录音接口接受 `audio_url`，因此只要 NAS 能提供 Gladia 可访问的 HTTPS 地址，就可以跳过 Gladia `/v2/upload`，直接把短期读取 URL 提交给 `/v2/pre-recorded`。这会把大文件数据流从 Vercel Blob 移出，但不会取消 Gladia 自身约 8,100 秒的媒体时长限制。

官方参考：

- [Gladia: Building note taker pipelines in Python](https://www.gladia.io/blog/building-note-taker-pipelines-in-python)
- [Gladia: Generate automated follow-up emails](https://www.gladia.io/blog/generate-automated-follow-up-emails-from-meeting-recordings)
- [Gladia asynchronous API integration guide](https://www.gladia.io/blog/gladia-async-api-for-meeting-transcription-integration-guide-and-best-practices)

## 3. 目标数据流

```text
浏览器 --请求上传会话--> Vercel 控制 API
浏览器 =====媒体直传====> NAS 上传端点
NAS ------对象编号-----> 浏览器/Vercel 控制 API
Vercel --短期读取 URL--> Gladia /v2/pre-recorded
Gladia ----任务状态----> Vercel 后台任务
Vercel --翻译/合并结果-> 浏览器固定 Job URL
任务完成 ----删除对象--> NAS
```

Vercel 只保存小型 JSON：job ID、对象编号、处理阶段、Gladia job ID、文字分段和最终结果。完整 NAS 签名 URL 不应长期写入日志。

## 4. NAS 必要条件

- NAS 必须能被 Gladia 从公网访问；局域网地址、Tailscale 私网地址不能直接提供给 Gladia。
- 使用有效域名和 HTTPS 证书，读取端点支持稳定的 `GET`，最好同时支持 `HEAD` 和 HTTP Range。
- NAS 上行带宽需要足以让 Gladia 拉取大文件；必须用真实 20 MB、100 MB 和长录音测量，不只做浏览器可访问测试。
- 浏览器上传使用短期、单对象、只写凭证；Gladia 读取使用另一条短期、单对象、只读签名 URL。
- 文件对象键由服务端生成随机值，原始文件名只作显示信息。
- 上传端限制媒体类型、最大尺寸、速率和并发，并支持幂等删除。

如果域名使用 Cloudflare 橙云代理或 Tunnel，大文件仍会经过 Cloudflare，可能重新受到请求体大小或超时限制。浏览器到 NAS 的大文件路径应优先使用可控的直连 HTTPS、DNS-only 子域，或经过验证的对象存储协议；网页和小型控制 API 可以继续走 Cloudflare。

## 5. 删除与保留策略

- **成功任务**：只有在 Gladia 已返回最终转写、翻译和结果文件已持久化后，才删除 NAS 原始媒体。
- **处理中**：不能在刚提交 `audio_url` 后立即删除，因为 Gladia 可能尚未完成异步下载。
- **可重试失败**：保留媒体，最长 48 小时。
- **不可恢复失败**：确认错误后立即删除。
- **兜底**：NAS 使用独立生命周期任务扫描超过 48 小时的临时媒体。该任务运行在 NAS/Ubuntu，不依赖 Vercel Cron。
- **文字结果**：TXT/SRT 和 job JSON 体积很小，使用与大媒体不同的保留策略。

## 6. 超长音频边界

迁移存储位置不能绕过 Gladia 的时长限制。超过 8,000 秒的媒体仍需切分，并严格串行提交，最后合并为一个 TXT/SRT。

推荐最终形态是在 NAS 或同一台 Ubuntu/Docker Worker 上运行 `ffprobe`/`ffmpeg`：

1. 上传结束后探测真实时长；
2. 不超过 8,000 秒时，直接生成一个短期读取 URL 给 Gladia；
3. 超过 8,000 秒时，在 NAS 本地切分，分别生成短期 URL；
4. 严格串行提交各段，保存断点；
5. 合并全局时间轴；
6. 成功后删除原始文件和全部分段。

这样媒体只上传一次到 NAS，切分发生在存储附近，不需要 Vercel 再下载整段媒体。

## 7. 两种实施层级

### A. NAS 直链 MVP

- 只支持不超过 8,000 秒的文件；
- 浏览器直传 NAS，Gladia 读取签名 URL；
- 保留现有 Vercel job、翻译和结果页面；
- 用于验证公网读取、带宽、签名和删除闭环。

### B. NAS Worker 完整版（推荐终态）

- Docker 部署上传服务、任务 Worker、SQLite/PostgreSQL 和清理服务；
- Worker 负责时长探测、切分、Gladia 串行提交、翻译、合并与删除；
- Vercel 可继续只托管前端，也可以在稳定后完全迁移到 Ubuntu。

## 8. 2026-09-25 存储技术选型调研

### 当前推荐：tusd + 普通 NAS 目录 + video2text Worker

当前产品是单用户、单任务、临时媒体处理，不需要分布式对象存储的大部分能力。更贴合需求的方案是：

- `tusd` 负责浏览器可恢复上传，直接写入 NAS 普通目录；
- `post-finish` 只向任务队列登记“上传完成”，不在 hook 内执行长时间转写；
- video2text Worker 直接读取普通文件，运行 `ffprobe`、`ffmpeg`、Gladia、翻译和合并；
- Worker 提供带 HMAC 签名和过期时间的 HTTPS 下载地址，供 Gladia 读取；
- Caddy/Nginx 负责域名、TLS、请求大小和基础限流；
- SQLite 保存单机任务状态，成功后删媒体，失败媒体最长保留 48 小时。

该方案的主要优势是 Safari/移动网络中断后可以续传，而且超长音频无需先从对象存储下载到 Worker：Worker 与上传目录共享 NAS 文件系统。tusd 官方提供本地磁盘后端和上传完成 hook；官方同时提示 hook 通常不重试，因此长任务必须交给独立任务系统。

### 如果需要标准 S3：优先评估 VersityGW

VersityGW 可以把现有 NAS 普通目录映射成 S3 API，对象键直接对应目录和文件，而不是使用私有磁盘布局。它提供 Linux/Windows 二进制和 Docker 镜像，采用 Apache 2.0 许可证。对本项目的价值是既可生成标准 S3 预签名 URL，又能让 Worker 直接访问正常文件路径。正式采用前仍需验证预签名 `PUT/GET`、CORS、Range、multipart 和 iOS 上传。

### 其他候选方案

| 方案 | 类型 | 优点 | 当前判断 |
|---|---|---|---|
| RustFS | 自托管 S3 | Apache 2.0、Docker、S3 兼容、项目活跃 | 可做第二个 S3 PoC；较新，不直接作为唯一生产存储 |
| Garage | 自托管 S3 | 轻量、强调家用网络和多地点复制 | 更适合多节点；S3 policy/versioning 等能力不完整，单 NAS 没有明显收益 |
| SeaweedFS | 分布式文件/对象存储 | S3、文件系统、横向扩展能力完整 | 功能过重，适合多节点或海量文件，不适合当前单用户任务 |
| rclone `serve s3` | S3 网关 | 可以快速把普通目录暴露为 S3 | 官方仍标记 Experimental，只用于原型验证 |
| Cloudflare R2 | 外部对象存储 | 浏览器预签名直传、无需公开 NAS、运维少 | 最简单的云端替代，但仍依赖第三方配额和计费 |
| Backblaze B2 | 外部对象存储 | S3 API、预签名上传和下载 | 可作为 R2 的外部云备选，同样不是自有 NAS |

### MinIO 结论修正

不再把 MinIO Community 作为新部署的默认推荐。其官方 `minio/minio` GitHub 仓库已于 2026-04-25 归档，并明确标记“不再维护”和社区版改为源码分发。现有 MinIO 系统可以继续评估迁移成本，但本项目没有必要新建一个依赖已归档社区仓库的生产环境。

### 推荐顺序

1. **首选 PoC**：tusd + 普通 NAS 目录 + Worker + 签名下载接口。
2. **需要 S3 标准时**：VersityGW + Worker。
3. **NAS 没有稳定公网入口时**：Cloudflare R2 或 Backblaze B2。
4. RustFS 作为新的自托管 S3 对照测试。
5. Garage、SeaweedFS 只在未来出现多节点、异地复制或海量文件需求时考虑。

官方资料：

- [tusd 官方文档](https://tus.github.io/tusd/)
- [tusd 本地磁盘后端](https://tus.github.io/tusd/storage-backends/local-disk/)
- [tusd hooks 与长任务边界](https://tus.github.io/tusd/advanced-topics/hooks/)
- [VersityGW 官方仓库](https://github.com/versity/versitygw)
- [VersityGW POSIX 后端](https://github.com/versity/versitygw/wiki/POSIX-Backend)
- [RustFS 官方仓库](https://github.com/rustfs/rustfs)
- [Garage 官方镜像仓库](https://github.com/deuxfleurs-org/garage)
- [SeaweedFS 官方仓库](https://github.com/seaweedfs/seaweedfs)
- [Cloudflare R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Backblaze B2 S3 API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
- [MinIO 官方归档仓库](https://github.com/minio/minio)

## 9. 安全要求

- Gladia 和翻译模型密钥只保存在服务端/NAS Worker，不发送到浏览器。
- 读取签名 URL 有短 TTL，且只允许读取一个对象；上传凭证不能读取或列出其他对象。
- Vercel 接受 NAS URL 时必须校验固定 HTTPS 主机，防止 SSRF；不能接受任意内网地址或跳转到内网。
- 日志只记录对象 ID 和脱敏 URL，不记录签名查询串、API Key 或完整请求头。
- 上传完成、任务完成和删除都使用幂等状态，网络重试不能重复提交付费转写。

## 10. 实施步骤

1. 确认 NAS 型号、系统、Docker 能力、公网域名、证书、上行带宽和磁盘目录。
2. 建一个测试子域和隔离目录，完成短期写入凭证、只读签名 URL、删除接口。
3. 用一个小音频验证浏览器直传 NAS、Gladia 通过 URL 拉取、成功后删除。
4. 用 iOS Safari、iOS Chrome 和 Windows 分别验证上传进度、中断和恢复。
5. 用 20 MB、100 MB、超过 8,000 秒三类文件做端到端测试。
6. 增加 NAS Worker 的时长探测、切分、串行提交和断点恢复。
7. 将生产页面置于功能开关后灰度：默认仍走 Vercel Blob，指定测试用户走 NAS。
8. 连续运行并监控容量、失败率、处理时长和删除闭环，通过后再切换默认路径。
9. 保留 Vercel Blob 路径作为短期回滚入口，稳定后再删除旧实现。

## 11. 验收标准

- 浏览器媒体请求不再进入 Vercel Blob，Vercel 仅保存小型任务与结果数据。
- Gladia 能稳定读取 NAS 短期 URL，且 URL 过期后无法再次访问。
- 成功任务不留下原始媒体；失败或中断媒体不超过 48 小时。
- 超过 8,000 秒的媒体正确切分、串行转写并合并全局 SRT 时间轴。
- 刷新固定 Job URL 后仍能恢复状态和下载结果。
- iOS Safari、iOS Chrome 和 Windows 端均通过真实文件测试。
- 任意外部 URL、私网 URL、跨对象删除和无签名上传均被拒绝。

## 12. 实施前待确认

- NAS 品牌、操作系统和是否可运行 Docker；
- 是否有固定公网 IP，或采用哪种 DDNS；
- 上传/读取子域是否能使用 DNS-only，而不是强制经过 Cloudflare 代理；
- NAS 实际上行带宽及运营商是否限制入站端口；
- 任务数据库选 SQLite 还是 PostgreSQL；
- 失败文件是否统一保留 48 小时，还是按错误类型提前删除；
- Vercel 只保留前端，还是最终也迁移到 Ubuntu。
