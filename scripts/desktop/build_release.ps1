$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$python = 'D:\projectQ\.venv\Scripts\python.exe'
$icon = Join-Path $root 'assets\video2text.ico'
$versionInfo = Join-Path $root 'build\version_info.txt'
$releaseRoot = Join-Path $root 'release\video2text'
$workModules = Join-Path $root 'outputs\work'
$configRoot = Join-Path $root 'config'
$releaseAppRoot = Join-Path $releaseRoot 'video2text'
$releaseWorkRoot = Join-Path $releaseAppRoot 'outputs\work'
$releaseConfigRoot = Join-Path $releaseAppRoot 'config'

if (Test-Path $releaseRoot) { Remove-Item -LiteralPath $releaseRoot -Recurse -Force }

& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name video2text `
  --icon $icon `
  --version-file $versionInfo `
  --paths $workModules `
  --hidden-import deepl_translate `
  --hidden-import gladia `
  --hidden-import run_zh_pipeline `
  --distpath $releaseRoot `
  --workpath (Join-Path $root 'build\pyinstaller') `
  --specpath (Join-Path $root 'build') `
  --add-data "$icon;assets" `
  --add-data "D:\program\ffmpeg\bin\ffmpeg.exe;bin" `
  --add-data "D:\program\ffmpeg\bin\ffprobe.exe;bin" `
  apps\desktop\main.py

New-Item -ItemType Directory -Force -Path $releaseWorkRoot | Out-Null
New-Item -ItemType Directory -Force -Path $releaseConfigRoot | Out-Null
Get-ChildItem -LiteralPath $workModules -File -Filter '*.py' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $releaseWorkRoot $_.Name) -Force
}
foreach ($name in @('gladia_keys.txt', 'deepl_key.txt', 'gladia_keys.example.txt', 'deepl_key.example.txt')) {
  $source = Join-Path $configRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $releaseConfigRoot $name) -Force
  }
}

Write-Host "Desktop release ready at: $releaseRoot"
