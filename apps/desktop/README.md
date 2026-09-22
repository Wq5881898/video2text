# Desktop App

`apps/desktop/main.py` is both the PyQt6 product entry point and the current desktop implementation. The old `app/` package is only a compatibility layer.

## Start From Source

```powershell
cd D:\projectQ\video2text
run_gui.bat
```

Direct Python entry:

```powershell
D:\projectQ\.venv\Scripts\python.exe apps\desktop\main.py
```

`run_gui.bat` sets the repository root as the working directory and `PYTHONPATH`, which prevents `ModuleNotFoundError: packages` when launched outside the repository.

## Product Capabilities

- drag files or folders into a local batch queue;
- Auto, English, Chinese, and English + Chinese source-language modes;
- TXT and SRT output;
- optional English-to-Chinese translation using MiniMax M3, GLM, or Qwen;
- streaming translation with serial batches and per-batch checkpoint writes;
- automatic splitting of recordings longer than 8,000 seconds;
- resume saved Gladia jobs and completed audio parts;
- API key management, environment checks, presets, logs, recent outputs, and job details;
- cleanup of temporary cache without deleting final TXT/SRT or API keys.

Translation is skipped when the source is Chinese, mixed-language, or not detected as English.

## API Key Management

Open `API Key Management` from the main toolbar.

- Gladia supports multiple keys in `config/gladia_keys.txt`, one per line. The usage display is an estimate based on visible current-month jobs and the published free allowance; it is not an official account balance.
- MiniMax uses `config/minimax.json` and defaults to `MiniMax-M3`.
- GLM uses `config/glm.json` and defaults to the configured GLM model.
- Qwen uses `config/qwen.json`; its private base URL and model must be supplied.
- Translation key tests verify authentication and the returned model. These chat-completion endpoints do not expose remaining account quota.
- Full keys are masked in the UI and omitted from runtime logs.

Each translation JSON contains:

```json
{
  "base_url": "https://provider.example/v1",
  "api_key": "replace-with-local-secret",
  "model": "provider-model-name"
}
```

Environment variables such as `MINIMAX_API_KEY`, `GLM_BASE_URL`, or `QWEN_MODEL` override the corresponding JSON fields.

## Long Recordings

- Media longer than 8,000 seconds is split locally into balanced parts below the safe limit.
- Parts are submitted to Gladia strictly serially and merged into one TXT or SRT named after the original file.
- SRT timestamps are shifted back to the original recording timeline.
- Polling timeouts resume the saved remote job with its submitting key binding.
- Completed parts are reused. A terminal remote failure is resubmitted only after a later manual retry.
- Extracted audio and split parts are deleted only after final output succeeds. Failed work retains audio and checkpoints for retry.
- Original recordings and videos are never deleted.

## Paths

| Runtime | Config | Job cache |
|---|---|---|
| Python source | `D:\projectQ\video2text\config\` | `D:\projectQ\video2text\outputs\work\jobs\` |
| Packaged EXE | `<exe-folder>\config\` | `<exe-folder>\outputs\work\jobs\` |

The packaged distribution must keep `video2text.exe`, `_internal/`, `config/`, and `outputs/` together.

## Build And Release Checks

```powershell
cd D:\projectQ\video2text
powershell -ExecutionPolicy Bypass -File scripts\desktop\build_release.ps1
```

The build bundles ffmpeg/ffprobe and then runs bounded hidden-window checks for:

- Python imports and Qt DLL loading;
- one unified config/jobs path;
- readable Gladia and MiniMax release configuration;
- English deduplication;
- generation and real FFmpeg splitting of a 12,309-second silent fixture;
- merged full-recording SRT timestamps;
- Qt window and drag/drop target initialization.

These build checks do not submit paid transcription jobs. Real Gladia and LLM tests remain separate.

---

# 桌面端说明

当前桌面端的真实入口与实现都是 `apps/desktop/main.py`，旧 `app/` 仅为兼容层。桌面端已支持三种 LLM 翻译模型、流式串行分批、8,000 秒长音频自动切分、断点续跑和成功后中间音频清理。完整产品状态见 [`../../docs/CURRENT_STATE_ZH.md`](../../docs/CURRENT_STATE_ZH.md)。
