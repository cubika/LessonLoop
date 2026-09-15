param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Assert-Unlinked([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup path is linked: $current" }
    }
    $parent = Split-Path $current -Parent
    if ($parent -eq $current) { break }
    $current = $parent
  }
}

function Resolve-Owned([string]$Root, [string]$Relative) {
  if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(":")) { throw "Invalid cleanup path" }
  foreach ($part in $Relative.Replace([char]92, [char]47).Split([char]47)) {
    if ($part -in @("", ".", "..") -or $part.EndsWith(".") -or $part.EndsWith(" ")) { throw "Invalid cleanup path" }
  }
  $target = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if (-not $target.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Cleanup path escaped its root" }
  Assert-Unlinked $target
  return $target
}

$planTarget = [IO.Path]::GetFullPath($PlanPath)
Assert-Unlinked $planTarget
$plan = Get-Content -LiteralPath $planTarget -Raw -Encoding UTF8 | ConvertFrom-Json
$program = [IO.Path]::GetFullPath($plan.programRoot)
$data = [IO.Path]::GetFullPath($plan.dataRoot)
foreach ($root in @($program, $data)) {
  Assert-Unlinked $root
  if ($root -eq [IO.Path]::GetPathRoot($root)) { throw "A drive root cannot be cleaned" }
}
if ($program -eq $data -or $program.StartsWith($data + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $data.StartsWith($program + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Program and data roots overlap" }
if ($planTarget -ne (Join-Path $data "removal-plan.json")) { throw "Unowned cleanup plan" }
$recordPath = Resolve-Owned $data "installation.json"
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($record.installationId -ne $plan.installationId -or $record.dataRoot -ne $data -or $record.runtimeRoot -ne $plan.runtimeRoot -or $record.setupState -ne "removal_pending" -or $record.removalAction -ne $plan.action) { throw "Cleanup ownership mismatch" }
$ownedProgram = if ($record.programRoot) { [IO.Path]::GetFullPath($record.programRoot) } else { [IO.Path]::GetFullPath($record.runtimeRoot) }
$ownedRuntime = [IO.Path]::GetFullPath($record.runtimeRoot)
if ($program -ne $ownedProgram -or ($ownedRuntime -ne $program -and -not $ownedRuntime.StartsWith($program + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) { throw "Program cleanup ownership mismatch" }
$activePath = Resolve-Owned $program "active.json"
if (Test-Path -LiteralPath $activePath) {
  $active = Get-Content -LiteralPath $activePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($active.installationId -ne $plan.installationId -or $active.dataRoot -ne $data) { throw "Active installation ownership mismatch" }
}
$dataLock = [IO.File]::Open((Resolve-Owned $data "manager.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$programLock = $null
$remaining = @()
try {
  if (Test-Path -LiteralPath $program) {
    $programLock = [IO.File]::Open((Resolve-Owned $program "installation.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  }
  if ($plan.action -eq "purge") {
    $allowed = @("storage/postgres", "backups", "host-state", "secrets.dpapi", "database-owner.json", "processes.json", "update-state.json", "core.log", "engine.log", "postgres.log", "database-manager.log", "update-backup-error.log")
    if (@($plan.dataItems).Count -ne $allowed.Count -or @(Compare-Object $allowed @($plan.dataItems)).Count) { throw "Data cleanup items changed" }
    # Inspect every descendant without following a link before any recursive deletion.
    foreach ($name in $plan.dataItems) {
      $target = Resolve-Owned $data $name
      if (Test-Path -LiteralPath $target) {
        $pending = New-Object 'System.Collections.Generic.Stack[string]'
        $pending.Push($target)
        while ($pending.Count) {
          $itemPath = $pending.Pop()
          Assert-Unlinked $itemPath
          if ((Get-Item -LiteralPath $itemPath -Force).PSIsContainer) {
            foreach ($item in (Get-ChildItem -LiteralPath $itemPath -Force)) { $pending.Push($item.FullName) }
          }
        }
      }
    }
    foreach ($name in $plan.dataItems) {
      $target = Resolve-Owned $data $name
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      if (Test-Path -LiteralPath $target) { throw "Data cleanup was incomplete: $target" }
    }
    $storage = Resolve-Owned $data "storage"
    if ((Test-Path -LiteralPath $storage) -and -not (Get-ChildItem -LiteralPath $storage -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $storage -Force }
    $identity = [ordered]@{installationId=$record.installationId;programRoot=$program;runtimeRoot=$record.runtimeRoot;dataRoot=$data;databasePort=$record.databasePort;corePort=$record.corePort;enginePort=$record.enginePort;scopeId="personal";allowedRoots=@();autostart=$false;setupState="purged"}
    if ($record.databaseRuntimeRoot) { $identity.databaseRuntimeRoot = $record.databaseRuntimeRoot }
    if ($record.manifestDigest) { $identity.manifestDigest = $record.manifestDigest }
    $identity | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $recordPath -Encoding UTF8
    Remove-Item -LiteralPath $planTarget -Force
    $remaining = @(Get-ChildItem -LiteralPath $data -Force | Where-Object { $_.Name -notin @("installation.json", "manager.lock") } | Select-Object -ExpandProperty FullName)
    @{status="purged";dataRoot=$data;retainedFiles=$remaining;next="Run setup to initialize a new empty database"} | ConvertTo-Json -Depth 4 -Compress
  } elseif ($plan.action -eq "uninstall") {
    $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $plan.programFiles) {
      $target = Resolve-Owned $program $name
      if (Test-Path -LiteralPath $target) {
        if ((Get-Item -LiteralPath $target -Force).PSIsContainer) { throw "Expected an installed file" }
        Remove-Item -LiteralPath $target -Force
      }
      $parent = Split-Path $target -Parent
      while ($parent -and $parent -ne $program) { [void]$directories.Add($parent); $parent = Split-Path $parent -Parent }
    }
    foreach ($name in @("active.json", "lessonloop.ps1")) {
      $target = Resolve-Owned $program $name
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    }
    $programLock.Dispose(); $programLock = $null
    Remove-Item -LiteralPath (Resolve-Owned $program "installation.lock") -Force
    foreach ($directory in @($directories | Sort-Object Length -Descending)) {
      Assert-Unlinked $directory
      if ((Test-Path -LiteralPath $directory) -and -not (Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $directory -Force }
    }
    $remaining = @(Get-ChildItem -LiteralPath $program -Force | Select-Object -ExpandProperty FullName)
    if (-not $remaining.Count) { Remove-Item -LiteralPath $program -Force }
    $record.setupState = $plan.previousSetupState
    $record.autostart = $false
    $record.PSObject.Properties.Remove("removalAction")
    $record | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $recordPath -Encoding UTF8
    Remove-Item -LiteralPath $planTarget -Force
    @{status="uninstalled";data="preserved";dataRoot=$data;retainedFiles=$remaining} | ConvertTo-Json -Depth 4 -Compress
  } else { throw "Unknown cleanup action" }
} finally {
  if ($programLock) { $programLock.Dispose() }
  $dataLock.Dispose()
}
