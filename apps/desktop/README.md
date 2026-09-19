# Desktop App

This folder is the desktop-product entrypoint layer.

Current status:
- wraps the existing PyQt6 application
- keeps compatibility with the current release/build scripts
- is the future home for desktop-only UI and packaging code

Current entrypoint:
- `apps/desktop/main.py`

Current implementation source:
- `app/main.py`
# API key management

Open `API Key Management` in the menu bar to maintain local provider credentials.

- Gladia supports multiple transcription keys. The app stores one key per line in `config/gladia_keys.txt`. It estimates current-month usage from visible job durations against Gladia's published 10-hour Free limit. Gladia does not expose the account plan or official remaining balance through its public API, so paid-plan usage still requires the provider dashboard.
- MiniMax M3 translation uses `config/minimax.json`. The key test verifies authentication and the actual model returned by the API; this endpoint does not expose account quota.
- Keys are masked in the table and are never written to the runtime log. Configuration files remain local and are excluded from Git.

## Long recordings / 超长录音

- Audio longer than 8,000 seconds is split locally into balanced parts below that limit. Parts are transcribed sequentially and merged into a single TXT or SRT named after the original file. SRT timestamps use the full recording timeline.
- Polling timeouts resume the saved remote job, including its original key binding. Completed parts are reused; terminal remote failures are resubmitted on a manual retry.
- Intermediate extracted audio and split parts are deleted only after the final output is written successfully. Failed work retains audio and checkpoints for retry. Original recordings and videos are never deleted.
- Python uses `outputs/work/jobs/` under the project root; EXE uses the same relative directory next to the executable. Both use `config/` at their application root for keys. EXE distributions must keep the executable, `_internal/`, `config/`, and `outputs/` together.

- 超过 8,000 秒的音频在本地均分为多个较短片段，逐段串行转写，最终仍生成一个与原文件同名的 TXT 或 SRT；字幕时间自动恢复为整段录音的时间线。
- 查询超时后重试会续接已保存的任务和原 Key，不重复上传；完成的分段直接复用。远端明确失败的分段在用户重试时重新提交。
- 只有最终结果成功写入后才删除提取音轨和切分音频；失败时保留音频与断点，方便重试。原始录音、视频不删除。
- Python 缓存位于项目根目录的 `outputs/work/jobs/`，EXE 缓存位于 EXE 同级的 `outputs/work/jobs/`，Key 统一存放在各自应用根目录的 `config/`。打包版本不能只移动 EXE，需保留其同级依赖目录。

## Release checks / 打包验证

`scripts/desktop/build_release.ps1` performs bounded, hidden-window checks for imports/DLLs, shared key paths, English deduplication, a generated 12,309-second silent audio split, merged subtitle timestamps, and Qt drag-and-drop target initialization. These checks do not submit paid transcription jobs. Real API testing is separate.

打包脚本自动验证 DLL 与模块导入、统一 Key 路径、去重脚本、12,309 秒生成静音音频的真实切分、字幕时间合并，以及 Qt 拖拽区域初始化。检查有超时保护，不会创建付费转写任务；真实 API 测试单独进行。
