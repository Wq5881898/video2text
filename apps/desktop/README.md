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

Open `Other > API Key Management` to maintain local provider credentials.

- Gladia supports multiple transcription keys. The app stores one key per line in `config/gladia_keys.txt`. It estimates current-month usage from visible job durations against Gladia's published 10-hour Free limit. Gladia does not expose the account plan or official remaining balance through its public API, so paid-plan usage still requires the provider dashboard.
- DeepL uses `config/deepl_key.txt`. The test reports key validity plus used, total, and remaining monthly characters.
- Keys are masked in the table and are never written to the runtime log. Configuration files remain local and are excluded from Git.
