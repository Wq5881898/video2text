param([string]$ExePath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = if ($ExePath) { [System.IO.Path]::GetFullPath($ExePath) } else { Join-Path $root 'release\video2text\video2text\video2text.exe' }
$dedupFixture = Join-Path $root 'tests\fixtures\dedup_raw.json'

if (-not (Test-Path -LiteralPath $exe)) {
  throw "Release executable not found: $exe"
}

$selfTestPath = Join-Path $env:TEMP "video2text-release-self-test-$PID.json"
$dedupOutputPath = Join-Path $env:TEMP "video2text-release-dedup-$PID.json"
$splitOutputPath = Join-Path $env:TEMP "video2text-release-split-$PID.json"
$guiOutputPath = Join-Path $env:TEMP "video2text-release-gui-$PID.json"

function Invoke-PackagedTest([string[]]$Arguments, [int]$TimeoutSeconds = 30) {
  $quotedArguments = @($Arguments | ForEach-Object { '"' + $_ + '"' })
  $process = Start-Process -FilePath $exe -ArgumentList $quotedArguments -WindowStyle Hidden -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      throw "Packaged test timed out: $($Arguments[0])"
    }
    if ($process.ExitCode -ne 0) {
      throw "Packaged test failed: $($Arguments[0]) (exit code $($process.ExitCode))."
    }
  }
  finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    $process.Dispose()
  }
}

try {
  Invoke-PackagedTest @('--self-test', $selfTestPath)
  $diagnostics = Get-Content -LiteralPath $selfTestPath -Raw | ConvertFrom-Json
  $expectedConfigRoot = (Join-Path (Split-Path -Parent $exe) 'config')
  if ($diagnostics.config_root -ne $expectedConfigRoot) {
    throw "Packaged config mismatch: expected $expectedConfigRoot, got $($diagnostics.config_root)"
  }
  $expectedJobsRoot = (Join-Path (Split-Path -Parent $exe) 'outputs\work\jobs')
  if ($diagnostics.jobs_root -ne $expectedJobsRoot) {
    throw "Packaged jobs path mismatch: expected $expectedJobsRoot, got $($diagnostics.jobs_root)"
  }
  if ($diagnostics.gladia_key_count -lt 1 -or -not $diagnostics.minimax_key_present) {
    throw 'Packaged API keys are not readable from the shared config directory.'
  }
  $failedChecks = @($diagnostics.environment | Where-Object { -not $_.ok })
  if ($failedChecks.Count) {
    throw "Packaged environment checks failed: $($failedChecks | ConvertTo-Json -Compress)"
  }
  if (-not $diagnostics.long_audio_supported -or $diagnostics.max_audio_seconds -ne 8000) {
    throw 'Packaged long-audio support is missing.'
  }
  Write-Host "Packaged environment self-test passed: $($diagnostics.config_root)"

  Invoke-PackagedTest @('--dedup-smoke-test', $dedupFixture, $dedupOutputPath)
  $dedupSegments = Get-Content -LiteralPath $dedupOutputPath -Raw | ConvertFrom-Json
  if (@($dedupSegments).Count -ne 2) {
    throw "Packaged dedup produced $(@($dedupSegments).Count) segments instead of 2."
  }
  Write-Host 'Packaged dedup smoke test passed: 2 segments'

  Invoke-PackagedTest @('--audio-split-smoke-test', $splitOutputPath) 120
  $split = Get-Content -LiteralPath $splitOutputPath -Raw | ConvertFrom-Json
  if (-not $split.ok -or -not $split.generated_test_audio -or @($split.parts).Count -ne 2 -or
      [Math]::Abs($split.source_seconds - 12309) -gt 1 -or
      @($split.actual_part_seconds | Where-Object { $_ -le 0 -or $_ -gt 8000 }).Count -gt 0 -or
      $split.merged_srt -notmatch '01:42:35,500') {
    throw "Packaged native audio split/merge test failed: $($split | ConvertTo-Json -Compress -Depth 5)"
  }
  Write-Host 'Packaged native split test passed: generated 12309s audio, 2 parts, global SRT timestamps'

  Invoke-PackagedTest @('--gui-smoke-test', $guiOutputPath)
  $gui = Get-Content -LiteralPath $guiOutputPath -Raw | ConvertFrom-Json
  if ($gui.title -notlike 'video2text *' -or -not $gui.frame_accepts_drops -or -not $gui.queue_accepts_drops) {
    throw "Packaged GUI initialization/drop-target test failed: $($gui | ConvertTo-Json -Compress)"
  }
  Write-Host "Packaged GUI initialization/drop-target test passed: $($gui.title)"
}
finally {
  Remove-Item -LiteralPath $selfTestPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dedupOutputPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $splitOutputPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $guiOutputPath -Force -ErrorAction SilentlyContinue
}
