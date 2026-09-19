param([string]$ReleaseRoot)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$python = 'D:\projectQ\.venv\Scripts\python.exe'
$icon = Join-Path $root 'assets\video2text.ico'
$versionInfo = Join-Path $root 'build\version_info.txt'
$releaseBase = [System.IO.Path]::GetFullPath((Join-Path $root 'release'))
if (-not $ReleaseRoot) { $ReleaseRoot = Join-Path $releaseBase 'video2text' }
$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
if (-not $releaseRoot.StartsWith($releaseBase + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Release target must be inside $releaseBase"
}
$workModules = Join-Path $root 'outputs\work'
$configRoot = Join-Path $root 'config'
$releaseAppRoot = Join-Path $releaseRoot 'video2text'
$releaseWorkRoot = Join-Path $releaseAppRoot 'outputs\work'
$releaseConfigRoot = Join-Path $releaseAppRoot 'config'
$releaseInternalRoot = Join-Path $releaseAppRoot '_internal'
$releaseQtBin = Join-Path $releaseInternalRoot 'PyQt6\Qt6\bin'

# Keep unrelated tools (for example Poppler) from influencing PyInstaller's
# binary dependency discovery through the parent process PATH.
$pythonDir = Split-Path -Parent $python
$env:PATH = "$pythonDir;$env:SystemRoot\System32;$env:SystemRoot"

$runningRelease = @(Get-Process video2text -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) })
if ($runningRelease.Count) {
  throw "Close the running release before rebuilding: $releaseRoot"
}

if (Test-Path $releaseRoot) { Remove-Item -LiteralPath $releaseRoot -Recurse -Force }

& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name video2text `
  --icon $icon `
  --version-file $versionInfo `
  --paths $root `
  --paths $workModules `
  --hidden-import packages.shared_core.audio_chunks `
  --hidden-import llm_translate `
  --hidden-import minimax_translate `
  --hidden-import gladia `
  --hidden-import run_zh_pipeline `
  --distpath $releaseRoot `
  --workpath (Join-Path $root 'build\pyinstaller') `
  --specpath (Join-Path $root 'build') `
  --add-data "$icon;assets" `
  --add-data "D:\program\ffmpeg\bin\ffmpeg.exe;bin" `
  --add-data "D:\program\ffmpeg\bin\ffprobe.exe;bin" `
  apps\desktop\main.py

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed (exit code $LASTEXITCODE). No release is ready."
}

New-Item -ItemType Directory -Force -Path $releaseWorkRoot | Out-Null
New-Item -ItemType Directory -Force -Path $releaseConfigRoot | Out-Null
Get-ChildItem -LiteralPath $workModules -File -Filter '*.py' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $releaseWorkRoot $_.Name) -Force
}
foreach ($name in @('gladia_keys.txt', 'minimax.json', 'glm.json', 'qwen.json', 'gladia_keys.example.txt', 'minimax.example.json')) {
  $source = Join-Path $configRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $releaseConfigRoot $name) -Force
  }
}

# PyInstaller may place Python's older VC runtime beside _internal while Qt ships
# a newer compatible runtime in Qt6\bin. Keep one version at DLL search priority.
foreach ($name in @('MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll')) {
  $qtRuntime = Join-Path $releaseQtBin $name
  if (Test-Path -LiteralPath $qtRuntime) {
    Copy-Item -LiteralPath $qtRuntime -Destination (Join-Path $releaseInternalRoot $name) -Force
  }
}

# Qt 6 on Windows links against the system ICU shim (unversioned exports).
# A Poppler directory on PATH can make PyInstaller collect incompatible ICU
# binaries whose exports are version-suffixed, causing QtCore error 127.
Get-ChildItem -LiteralPath $releaseInternalRoot -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'icuuc.dll' -or $_.Name -like 'icudt*.dll' } |
  Remove-Item -Force

if (Test-Path -LiteralPath (Join-Path $releaseInternalRoot 'icuuc.dll')) {
  throw 'Incompatible non-system ICU DLL remains in the release.'
}

& (Join-Path $PSScriptRoot 'smoke_test_release.ps1') -ExePath (Join-Path $releaseAppRoot 'video2text.exe')
Write-Host "Desktop release verified at: $releaseAppRoot"
