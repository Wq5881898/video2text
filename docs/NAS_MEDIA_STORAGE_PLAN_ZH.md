# NAS 媒体存储迁移方案（长期任务）

> 状态：预览版代码已实现并通过本地自动化测试，尚未部署到 Ubuntu/NAS
> 建档日期：2026-09-23
> 技术选型复核：2026-09-25
> 网络与保留策略复核：2026-09-25
> 原则：先完成并验证 Vercel Blob 的短期止损，再单独实施 NAS 迁移；未通过端到端测试前不替换现有生产入口。

## 1. 目标与阶段划分

当前浏览器先把媒体上传到 Vercel Blob，再由云端提交给 Gladia。该结构能支持 Safari 和后台任务，但会占用 Vercel Blob 配额，清理失效时可能导致整个存储被 Hobby 套餐封停。

工作分成两个阶段：

1. **短期止损（当前代码已实现）**：任务成功生成最终结果后立即删除原始上传媒体；每次开始新上传时清理超过 48 小时的失败或遗留媒体；取消 Vercel Cron。
2. **长期迁移（本文范围）**：浏览器把文件直接上传到用户 NAS；Vercel 仅签发短期上传票据并代理状态/结果查询，不再保存音频或视频。任务状态、文字结果和媒体生命周期由 Ubuntu Worker 管理。

## 2. 可行性结论

可行。Gladia 的预录音接口接受 `audio_url`，因此只要 NAS 能提供 Gladia 可访问的 HTTPS 地址，就可以跳过 Gladia `/v2/upload`，直接把短期读取 URL 提交给 `/v2/pre-recorded`。这会把大文件数据流从 Vercel Blob 移出，但不会取消 Gladia 自身约 8,100 秒的媒体时长限制。

官方参考：

- [Gladia: Building note taker pipelines in Python](https://www.gladia.io/blog/building-note-taker-pipelines-in-python)
- [Gladia: Generate automated follow-up emails](https://www.gladia.io/blog/generate-automated-follow-up-emails-from-meeting-recordings)
- [Gladia asynchronous API integration guide](https://www.gladia.io/blog/gladia-async-api-for-meeting-transcription-integration-guide-and-best-practices)

## 3. 目标数据流

```text
浏览器 --请求上传会话--> Vercel 控制 API
浏览器 =====媒体直传====> DNS-only 上传域名 / Caddy / tusd
tusd -----上传完成事件-> Ubuntu video2text Worker
Worker --短期读取 URL--> Gladia /v2/pre-recorded
Gladia ----任务状态----> Ubuntu video2text Worker
Worker --翻译/合并结果-> 浏览器固定 Job URL
本地生命周期任务 ------> 删除超过 7 天的临时媒体
```

Vercel 只保留网页、固定 Job URL 和票据/查询代理；SQLite 任务状态和文字结果位于 Ubuntu 数据盘。媒体上传、时长探测、切分、Gladia 调用、翻译、合并和媒体清理由 Ubuntu Worker 承担。完整 NAS 签名 URL 不应长期写入日志。

当前网络采用双通道：Hermes 和 Sub2API 继续使用现有 Cloudflare Tunnel；音频数据使用独立的 DNS-only 子域，经过公网 443 端口映射直接进入 Ubuntu 虚拟机，不经过 Cloudflare Tunnel 或橙云代理。

## 4. NAS 必要条件

- NAS 必须能被 Gladia 从公网访问；局域网地址、Tailscale 私网地址不能直接提供给 Gladia。
- 使用有效域名和 HTTPS 证书，读取端点支持稳定的 `GET`，最好同时支持 `HEAD` 和 HTTP Range。
- NAS 上行带宽需要足以让 Gladia 拉取大文件；必须用真实 20 MB、100 MB 和长录音测量，不只做浏览器可访问测试。
- 浏览器上传使用短期、单对象、只写凭证；Gladia 读取使用另一条短期、单对象、只读签名 URL。
- 文件对象键由服务端生成随机值，原始文件名只作显示信息。
- 上传端限制媒体类型、最大尺寸、速率和并发，并支持幂等删除。

如果域名使用 Cloudflare 橙云代理或 Tunnel，大文件仍会经过 Cloudflare，可能重新受到请求体大小或超时限制。浏览器到 NAS 的大文件路径应优先使用可控的直连 HTTPS、DNS-only 子域，或经过验证的对象存储协议；网页和小型控制 API 可以继续走 Cloudflare。

## 5. 删除与保留策略

- **现有 Vercel Blob 路径**：继续维持“任务成功后立即删除媒体、上传时清理超过 48 小时遗留媒体”的止损策略，直到旧路径正式下线。
- **未来 NAS 路径**：成功和失败的原始媒体均保留 7 天，不在成功后立即删除，便于重新处理和故障排查。
- **清理调度**：本地任务每天运行一次，删除生命周期已超过 7 天的媒体。不要仅每 7 天运行一次，否则文件最坏可能保留接近 14 天。
- **未完成上传**：与完整媒体分开管理；长时间没有更新的残缺上传应更早回收，建议 24 小时。
- **容量保护**：当专用数据盘使用率达到 80% 时，优先清理最旧且已经完成的媒体，防止磁盘写满导致整个处理链路停止。
- **文字结果**：TXT/SRT 和 job JSON 体积很小，使用与大媒体不同的保留策略，可长期保存或另设更长周期。

## 6. 超长音频边界

迁移存储位置不能绕过 Gladia 的时长限制。超过 8,000 秒的媒体仍需切分，并严格串行提交，最后合并为一个 TXT/SRT。

推荐最终形态是在 NAS 或同一台 Ubuntu/Docker Worker 上运行 `ffprobe`/`ffmpeg`：

1. 上传结束后探测真实时长；
2. 不超过 8,000 秒时，直接生成一个短期读取 URL 给 Gladia；
3. 超过 8,000 秒时，在 NAS 本地切分，分别生成短期 URL；
4. 严格串行提交各段，保存断点；
5. 合并全局时间轴；
6. 成功后标记任务完成；原始文件和全部分段进入 7 天生命周期清理。

这样媒体只上传一次到 NAS，切分发生在存储附近，不需要 Vercel 再下载整段媒体。

## 7. 两种实施层级

### A. NAS 直链 MVP

- 只支持不超过 8,000 秒的文件；
- 浏览器直传 NAS，Gladia 读取签名 URL；
- 保留现有 Vercel job、翻译和结果页面；
- 用于验证公网读取、带宽、签名和删除闭环。

### B. NAS Worker 完整版（推荐终态）

- Ubuntu 虚拟机使用 Docker 部署 Caddy、上传服务、任务 Worker、SQLite 和清理服务；
- Worker 负责时长探测、切分、Gladia 串行提交、翻译、合并与删除；
- Vercel 第一阶段继续托管网页和固定 Job URL；旧云端处理链路保留为回滚开关。NAS 端通过真实文件测试并稳定运行后，再决定是否撤掉 Vercel 后台处理代码，避免一次迁移破坏现有可用版本。

## 8. 2026-09-25 存储技术选型调研

### 当前推荐：Caddy + tusd + Ubuntu 专用数据盘 + video2text Worker

当前产品是单用户、单任务、临时媒体处理，不需要分布式对象存储的大部分能力。更贴合需求的方案是：

- `tusd` 负责浏览器可恢复上传，直接写入 Ubuntu 专用虚拟数据盘；
- `post-finish` 只向任务队列登记“上传完成”，不在 hook 内执行长时间转写；
- video2text Worker 直接读取普通文件，运行 `ffprobe`、`ffmpeg`、Gladia、翻译和合并；
- Worker 提供带 HMAC 签名和过期时间的 HTTPS 下载地址，供 Gladia 读取；
- Caddy 负责域名、自动 HTTPS、反向代理和基础安全头；
- SQLite 保存单机任务状态，媒体统一保留 7 天，由本地生命周期任务每天扫描清理。

该方案的主要优势是 Safari/移动网络中断后可以续传，而且超长音频无需先从对象存储下载到 Worker：Worker 与上传目录共享 NAS 文件系统。tusd 官方提供本地磁盘后端和上传完成 hook；官方同时提示 hook 通常不重试，因此长任务必须交给独立任务系统。

### 反向代理选择：Caddy

当前规模优先选择 Caddy：配置量小、自动申请和续期公网 HTTPS 证书，默认反向代理路径不需要像 Nginx 那样专门关闭请求体缓冲。Nginx 同样可用，但 tusd 官方要求反向代理禁用 request buffering，并调整请求大小、原始主机名和协议转发；这些都是额外的配置和回归测试点。未来如果需要复杂 WAF、成熟的 Nginx 运维体系或团队已经统一使用 Nginx，再切换也不会影响 tusd 和 Worker 架构。

### 数据盘选择：Ubuntu 专用虚拟数据盘

效率优先时，不把临时媒体写入 Ubuntu 系统根盘，也不优先使用 SMB/CIFS 共享目录。推荐在 NAS 存储池上给 Ubuntu 虚拟机挂载一块独立虚拟块设备，在虚拟机内格式化为 ext4 或 XFS，并把整块应用数据盘挂载到通用根目录 `/srv/app-data`。video2text 只使用 `/srv/app-data/video2text`；未来其他附件服务使用各自的子目录、UID 和清理规则。tusd、Worker 和媒体读取服务共享 video2text 子目录，上传完成后无需复制文件。

如果只能通过 NFS/共享目录访问 NAS 文件夹，必须先验证硬链接和文件锁。tusd 本地磁盘后端使用硬链接实现上传锁，部分 NFS 或虚拟机共享文件夹可能不兼容。最终 TXT/SRT 可以另行同步到 NAS 普通共享目录，但媒体处理热路径应留在专用虚拟数据盘。

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

代码阶段已经完成：`deploy/nas/` 提供 Caddy、tusd、单线程 Worker、SQLite 和 systemd 清理任务；`/nas` 是不影响现有 Vercel Blob 入口的灰度页面；浏览器使用 50 MiB 分块和断点续传；Worker 复用共享长音频流水线，并用 HMAC 短期 URL 供 Gladia 拉取。

后续实机步骤：

1. 在 Ubuntu 将应用数据盘挂载到 `/srv/app-data`，准备 `/srv/app-data/video2text` 与 `/srv/video2text-config`。
2. 建立 DNS-only 上传子域和公网 80/443 端口映射，运行 `deploy/nas/preflight.sh`。
3. 启动 Compose，并配置 Vercel 的 NAS 预览环境变量。
4. 用一个小音频验证浏览器直传 NAS、Gladia 通过 URL 拉取、任务完成后媒体进入 7 天保留期。
4. 用 iOS Safari、iOS Chrome 和 Windows 分别验证上传进度、中断和恢复。
5. 用 20 MB、100 MB、超过 8,000 秒三类文件做端到端测试。
6. 增加 NAS Worker 的时长探测、切分、串行提交和断点恢复。
7. 将生产页面置于功能开关后灰度：默认仍走 Vercel Blob，指定测试用户走 NAS。
8. 连续运行并监控容量、失败率、处理时长和删除闭环，通过后再切换默认路径。
9. 保留 Vercel Blob 路径作为短期回滚入口，稳定后再删除旧实现。

## 11. 验收标准

- 浏览器媒体请求不再进入 Vercel Blob，Vercel 仅保存小型任务与结果数据。
- Gladia 能稳定读取 NAS 短期 URL，且 URL 过期后无法再次访问。
- 成功和失败媒体在 7 天后被本地生命周期任务删除；残缺上传在 24 小时后被回收。
- 超过 8,000 秒的媒体正确切分、串行转写并合并全局 SRT 时间轴。
- 刷新固定 Job URL 后仍能恢复状态和下载结果。
- iOS Safari、iOS Chrome 和 Windows 端均通过真实文件测试。
- 任意外部 URL、私网 URL、跨对象删除和无签名上传均被拒绝。

## 12. 部署前待确认

- NAS 品牌、操作系统和是否可运行 Docker；
- 是否有固定公网 IP，或采用哪种 DDNS；
- 上传/读取子域是否能使用 DNS-only，而不是强制经过 Cloudflare 代理；
- NAS 实际上行带宽及运营商是否限制入站端口；
- Ubuntu SSH 登录方式和仓库部署目录；
- 专用虚拟数据盘的设备名、容量和最终挂载点；
- `upload.151077.xyz` 是否作为正式 DNS-only 子域；
- 公网路由器能否把 TCP 80/443 转发到 Ubuntu，且未被其他服务占用；
- Vercel 只长期保留前端，还是稳定后也迁移到 Ubuntu。
