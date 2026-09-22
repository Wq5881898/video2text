param(
  [string]$Version,
  [string]$SourceRoot,
  [string]$ArtifactRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$releaseBase = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'release'))

if (-not $Version) {
  $meta = Get-Content -LiteralPath (Join-Path $repoRoot 'apps\desktop\meta.py') -Raw
  $match = [regex]::Match($meta, 'APP_VERSION\s*=\s*"([^"]+)"')
  if (-not $match.Success) { throw 'Could not read APP_VERSION from apps/desktop/meta.py' }
  $Version = $match.Groups[1].Value
}

if (-not $SourceRoot) { $SourceRoot = Join-Path $releaseBase 'video2text\video2text' }
if (-not $ArtifactRoot) { $ArtifactRoot = Join-Path $releaseBase 'artifacts' }
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
$ArtifactRoot = [System.IO.Path]::GetFullPath($ArtifactRoot)
$stagingBase = [System.IO.Path]::GetFullPath((Join-Path $releaseBase 'public-staging'))
$stagingRoot = Join-Path $stagingBase 'video2text'

function Assert-WithinRelease([string]$Path, [string]$Label) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($releaseBase + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be inside $releaseBase"
  }
}

Assert-WithinRelease $SourceRoot 'SourceRoot'
Assert-WithinRelease $ArtifactRoot 'ArtifactRoot'
Assert-WithinRelease $stagingBase 'StagingRoot'

$exe = Join-Path $SourceRoot 'video2text.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Built release not found: $exe" }

# Record local secrets only for leak detection. They are never printed.
$secretValues = [System.Collections.Generic.List[string]]::new()
$sourceConfig = Join-Path $SourceRoot 'config'
$gladiaPath = Join-Path $sourceConfig 'gladia_keys.txt'
if (Test-Path -LiteralPath $gladiaPath) {
  Get-Content -LiteralPath $gladiaPath | ForEach-Object {
    $value = $_.Trim()
    if ($value -and -not $value.StartsWith('#') -and $value.Length -ge 8) { $secretValues.Add($value) }
  }
}
foreach ($name in @('minimax.json', 'glm.json', 'qwen.json')) {
  $path = Join-Path $sourceConfig $name
  if (Test-Path -LiteralPath $path) {
    try {
      $value = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).api_key
      if ($value -and $value.Length -ge 8) { $secretValues.Add([string]$value) }
    }
    catch { throw "Invalid local translation config: $path" }
  }
}

if (Test-Path -LiteralPath $stagingBase) { Remove-Item -LiteralPath $stagingBase -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stagingBase | Out-Null
Copy-Item -LiteralPath $SourceRoot -Destination $stagingRoot -Recurse -Force

$publicConfig = Join-Path $stagingRoot 'config'
New-Item -ItemType Directory -Force -Path $publicConfig | Out-Null
foreach ($name in @('gladia_keys.txt', 'deepl_key.txt', 'minimax.json', 'glm.json', 'qwen.json')) {
  Remove-Item -LiteralPath (Join-Path $publicConfig $name) -Force -ErrorAction SilentlyContinue
}

Set-Content -LiteralPath (Join-Path $publicConfig 'gladia_keys.txt') -Encoding utf8 -Value @(
  '# Add one Gladia API key per line, or use API Key Management in the app.'
)
@{
  base_url = 'https://api.minimaxi.com/v1'
  api_key = ''
  model = 'MiniMax-M3'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $publicConfig 'minimax.json') -Encoding utf8
@{
  base_url = 'https://api.z.ai/api/coding/paas/v4'
  api_key = ''
  model = 'glm-5.3-flash'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $publicConfig 'glm.json') -Encoding utf8
@{
  base_url = ''
  api_key = ''
  model = ''
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $publicConfig 'qwen.json') -Encoding utf8

$jobsRoot = Join-Path $stagingRoot 'outputs\work\jobs'
if (Test-Path -LiteralPath $jobsRoot) { Remove-Item -LiteralPath $jobsRoot -Recurse -Force }
Get-ChildItem -LiteralPath (Join-Path $stagingRoot 'outputs\work') -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in @('.log', '.job_id') -or $_.Name -like '*state*.json' } |
  Remove-Item -Force

$firstRead = @'
video2text Windows release

1. Keep this whole folder together. Do not move video2text.exe by itself.
2. Run video2text.exe.
3. Open API Key Management and add at least one Gladia key.
4. Add a MiniMax, GLM, or Qwen key only when Chinese translation is needed.
5. Final TXT/SRT files are not removed by Cleanup Cache.

This public package intentionally contains no API keys.
'@
Set-Content -LiteralPath (Join-Path $stagingRoot 'README-FIRST.txt') -Value $firstRead -Encoding utf8

$textExtensions = @('.txt', '.json', '.py', '.md', '.ini', '.cfg', '.yaml', '.yml', '.env', '.log')
if ($secretValues.Count) {
  foreach ($file in Get-ChildItem -LiteralPath $stagingRoot -Recurse -File) {
    if ($file.Extension.ToLowerInvariant() -notin $textExtensions) { continue }
    $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    foreach ($secret in $secretValues) {
      if ($content -and $content.Contains($secret)) {
        throw "Secret material remains in public staging file: $($file.FullName)"
      }
    }
  }
}

New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
$zipName = "video2text-windows-x64-v$Version.zip"
$zipPath = Join-Path $ArtifactRoot $zipName
$hashPath = "$zipPath.sha256"
Remove-Item -LiteralPath $zipPath, $hashPath -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $stagingRoot -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $hashPath -Encoding ascii -NoNewline -Value "$hash  $zipName`n"

Write-Host "Public release package: $zipPath"
Write-Host "SHA256: $hash"
