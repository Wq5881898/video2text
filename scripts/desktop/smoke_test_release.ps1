$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $root 'release\video2text\video2text\video2text.exe'

if (-not (Test-Path -LiteralPath $exe)) {
  throw "Release executable not found: $exe"
}

$selfTestPath = Join-Path $env:TEMP "video2text-release-self-test-$PID.json"
$selfTest = Start-Process -FilePath $exe -ArgumentList '--self-test', $selfTestPath -PassThru -Wait
try {
  if ($selfTest.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $selfTestPath)) {
    throw "Packaged environment self-test failed (exit code $($selfTest.ExitCode))."
  }
  $diagnostics = Get-Content -LiteralPath $selfTestPath -Raw | ConvertFrom-Json
  $expectedConfigRoot = (Join-Path (Split-Path -Parent $exe) 'config')
  if ($diagnostics.config_root -ne $expectedConfigRoot) {
    throw "Packaged config mismatch: expected $expectedConfigRoot, got $($diagnostics.config_root)"
  }
  $expectedJobsRoot = (Join-Path (Split-Path -Parent $exe) 'outputs\work\jobs')
  if ($diagnostics.jobs_root -ne $expectedJobsRoot) {
    throw "Packaged jobs path mismatch: expected $expectedJobsRoot, got $($diagnostics.jobs_root)"
  }
  if ($diagnostics.gladia_key_count -lt 1 -or -not $diagnostics.deepl_key_present) {
    throw 'Packaged API keys are not readable from the shared config directory.'
  }
  $failedChecks = @($diagnostics.environment | Where-Object { -not $_.ok })
  if ($failedChecks.Count) {
    throw "Packaged environment checks failed: $($failedChecks | ConvertTo-Json -Compress)"
  }
  Write-Host "Packaged environment self-test passed: $($diagnostics.config_root)"
}
finally {
  Remove-Item -LiteralPath $selfTestPath -Force -ErrorAction SilentlyContinue
}

$process = Start-Process -FilePath $exe -PassThru
try {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) {
      throw "Release exited before opening its main window (exit code $($process.ExitCode))."
    }
    $title = $process.MainWindowTitle
    if ($title -like 'video2text *') {
      Write-Host "Release smoke test passed: $title"
      exit 0
    }
    if ($title -match 'exception|error|failed') {
      throw "Release opened an error window: $title"
    }
  } while ((Get-Date) -lt $deadline)
  throw "Release did not open the expected main window. Last title: $title"
}
finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
