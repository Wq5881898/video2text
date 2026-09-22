# video2text v0.1.0

首个 GitHub Windows 正式发布版本。

## 主要功能

- 音频和视频转 TXT/SRT，支持文件、文件夹和拖拽批量队列；
- 自动、英文、中文和中英混合源语言模式；
- 英文中译支持 MiniMax M3、GLM 和 Qwen，采用流式串行分批；
- 超过 8,000 秒的媒体自动切分、逐段转写并合并为一个结果；
- Gladia 多 Key、翻译模型 Key 管理与连接检测；
- 转写和翻译断点缓存，失败后可继续；
- 成功后清理视频提取音轨和分段，失败时保留以供重试；
- 内置 ffmpeg/ffprobe，无需用户另行安装；
- 修复 PyInstaller 模块、QtCore DLL、ICU 冲突、统一配置路径和拖拽初始化问题。

## 下载与启动

下载 `video2text-windows-x64-v0.1.0.zip` 并完整解压，然后运行：

```text
video2text\video2text.exe
```

不要只移动 EXE。`_internal`、`config` 和 `outputs` 必须与程序保持在同一目录结构中。

公开发布包不包含任何 API Key。首次启动后打开 `API Key Management`，至少添加一个 Gladia Key；只有需要中译时才需要配置 MiniMax、GLM 或 Qwen。

## 完整性校验

`video2text-windows-x64-v0.1.0.zip.sha256` 包含 ZIP 的 SHA256。PowerShell 校验：

```powershell
Get-FileHash .\video2text-windows-x64-v0.1.0.zip -Algorithm SHA256
```

## 验证范围

- Python 单元测试；
- Web Node 单元测试；
- 打包后模块和 DLL 加载；
- 配置与 job cache 路径；
- English dedup；
- 真实生成 12,309 秒静音音频并切分为两段；
- 合并后的完整 SRT 时间轴；
- Qt 窗口和拖拽区域初始化；
- 公开 ZIP 密钥清理与泄漏扫描。

自动 smoke test 不会创建付费 Gladia/LLM 任务。
