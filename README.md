# video2text

Audio to bilingual subtitle pipeline, migrated from the local session workspace into `D:\projectQ\video2text`.

## Current Scope

- Production entrypoint: `run_pipeline.bat`
- Main Windows pipeline: `outputs/work/run_all_win.py`
- Single-title driver: `outputs/work/run_zh_pipeline.py`
- English transcript cleanup: `outputs/work/dedup.py`
- English to Chinese translation: `outputs/work/deepl_translate.py`

## Current Architecture

1. Gladia performs English-only STT.
2. `dedup.py` cleans and merges transcript segments.
3. DeepL translates English segments to Chinese.
4. The pipeline builds bilingual `.srt` subtitles next to the source audio.

## Expected Local Paths

- Source audio directory defaults to `D:\DownloadTest`
- Repository root is `D:\projectQ\video2text`
- Working cache stays under `outputs/work`

## First-Time Setup

1. Copy `outputs/work/keys.example` to `outputs/work/keys` and fill in one Gladia key per line.
2. Copy `outputs/work/deeplkey.example.txt` to `outputs/work/deeplkey.txt` and fill in your DeepL Free API key.
3. Put audio files in `D:\DownloadTest`.
4. Run `run_pipeline.bat`.

## Migration Notes

- This repository intentionally excludes generated jobs, logs, runtime state, and API keys from git.
- Historical output and cache folders from the old workspace have not been fully migrated yet.
- The first migration batch preserves the original `outputs/work` layout to minimize path breakage during validation.

## Next Steps

- Validate the D-drive repo can execute the pipeline from its new location.
- Move selected historical sample artifacts into a tracked `samples/` or `fixtures/` area if they are useful for regression testing.
- Add a desktop UI layer in PyQt6 on top of the existing pipeline scripts.
