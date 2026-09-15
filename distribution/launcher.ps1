param([Parameter(Position=0)][string]$Action="status",[Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference="Stop"
$utf8=New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
$env:PYTHONUTF8="1"
$env:PYTHONIOENCODING="utf-8"
$program=[IO.Path]::GetFullPath($PSScriptRoot)
$active=Get-Content -LiteralPath (Join-Path $program "active.json") -Raw -Encoding UTF8|ConvertFrom-Json
$runtime=[IO.Path]::GetFullPath($active.runtimeRoot)
if($runtime -ne $program -and -not $runtime.StartsWith($program+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Runtime is outside this installation"}
$installation=Get-Content -LiteralPath (Join-Path $active.dataRoot "installation.json") -Raw -Encoding UTF8|ConvertFrom-Json
if($installation.installationId -ne $active.installationId){throw "Installation ownership mismatch"}
$runtimeRecord=$installation
if($installation.runtimeRoot -ne $runtime){
  $journal=Get-Content -LiteralPath (Join-Path $active.dataRoot "update-state.json") -Raw -Encoding UTF8|ConvertFrom-Json
  if($Action -ne "rollback" -or $journal.installationId -ne $active.installationId -or $journal.phase -notin @("prepared","backed_up","switching","checking")){throw "Installation state requires rollback"}
  $runtime=[IO.Path]::GetFullPath($journal.from)
  $runtimeRecord=$journal.previousRecord
  if($runtime -ne [IO.Path]::GetFullPath($journal.previousRecord.runtimeRoot)){throw "Recovery record mismatch"}
  if($runtime -ne $program -and -not $runtime.StartsWith($program+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Recovery runtime outside installation"}
}
$ancestor=$runtime
while($ancestor){if(Test-Path -LiteralPath $ancestor){if((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Runtime path is linked"}};$next=Split-Path $ancestor -Parent;if($next -eq $ancestor){break};$ancestor=$next}
$python=Join-Path $runtime "python/python.exe"
if ($runtimeRecord.runtimeExecutables) {
  $python=[string]$runtimeRecord.runtimeExecutables.python
  if (-not [IO.Path]::IsPathRooted($python) -or [IO.Path]::GetFullPath($python) -ne $python) { throw "Python executable binding must be an absolute path" }
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Installed Python environment is missing; rerun the installer" }
if ($Action -in @("uninstall", "data")) {
  $cleanup = Join-Path ([IO.Path]::GetTempPath()) ("lessonloop-cleanup-" + [Guid]::NewGuid().ToString() + ".ps1")
  Copy-Item -LiteralPath (Join-Path $runtime "distribution/cleanup.ps1") -Destination $cleanup
  $output = & $python -E -s -B -X utf8 (Join-Path $runtime "distribution/runtime.py") $Action --runtime-root $runtime --data-root $active.dataRoot @Arguments
  if ($LASTEXITCODE -ne 0) { $code=$LASTEXITCODE; Remove-Item -LiteralPath $cleanup -Force; $output | Write-Output; exit $code }
  $result = $output | Select-Object -Last 1 | ConvertFrom-Json
  if ($result.status -ne "cleanup_required") { throw "Runtime did not authorize cleanup" }
  try {
    & $cleanup -PlanPath $result.plan
    Remove-Item -LiteralPath $cleanup -Force
    exit 0
  } catch {
    Write-Error ("Cleanup did not finish. Retry: & '" + $cleanup.Replace("'", "''") + "' -PlanPath '" + $result.plan.Replace("'", "''") + "'. " + $_.Exception.Message)
    exit 1
  }
}
if ($Action -eq "cli") {
  & $python -E -s -B -X utf8 (Join-Path $runtime "distribution/runtime.py") $Action --runtime-root $runtime --data-root $active.dataRoot -- @Arguments
} else {
  & $python -E -s -B -X utf8 (Join-Path $runtime "distribution/runtime.py") $Action --runtime-root $runtime --data-root $active.dataRoot @Arguments
}
exit $LASTEXITCODE
