param([Parameter(Mandatory=$true)][string]$Bundle,[string]$InstallRoot=(Join-Path $env:LOCALAPPDATA "LessonLoopRuntime"),[string]$DataRoot=(Join-Path $env:LOCALAPPDATA "LessonLoop"),[switch]$AllowDevelopmentBuild)
$ErrorActionPreference="Stop"
$bundleRoot=(Resolve-Path -LiteralPath $Bundle).Path
$installTarget=[IO.Path]::GetFullPath($InstallRoot)
$dataTarget=[IO.Path]::GetFullPath($DataRoot)
if($installTarget -eq [IO.Path]::GetPathRoot($installTarget) -or $dataTarget -eq [IO.Path]::GetPathRoot($dataTarget)){throw "Root directories are not valid targets"}
if($installTarget -eq $dataTarget){throw "Program and data directories must differ"}
foreach($targetRoot in @($installTarget,$dataTarget)){
  $ancestor=$targetRoot
  while($ancestor){if(Test-Path -LiteralPath $ancestor){$existing=Get-Item -LiteralPath $ancestor;if($existing.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Installation target ancestor is a reparse point"}};$next=Split-Path $ancestor -Parent;if($next -eq $ancestor){break};$ancestor=$next}
}
if($installTarget.StartsWith($dataTarget+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $dataTarget.StartsWith($installTarget+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Program and data roots cannot contain each other"}
$installParent=Split-Path $installTarget -Parent
New-Item -ItemType Directory -Path $installParent -Force|Out-Null
$installLockPath=$installTarget+".install.lock"
$installLock=[IO.File]::Open($installLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$manifest=Get-Content -LiteralPath (Join-Path $bundleRoot "manifest.json") -Raw | ConvertFrom-Json
if($manifest.platform -ne "win32-x64" -or -not [Environment]::Is64BitOperatingSystem){throw "Windows x64 is required"}
if(-not $manifest.releaseReady -and -not $AllowDevelopmentBuild){throw "This bundle is a development build, not an accepted release"}
$seenPaths=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach($file in $manifest.files){
  if(-not $seenPaths.Add($file.path.Replace([char]92,[char]47))){throw "Duplicate manifest path"}
  if($file.path.Contains(":")){throw "Alternate stream or absolute path rejected"}
  foreach($part in $file.path.Replace([char]92,[char]47).Split([char]47)){if($part.EndsWith(".") -or $part.EndsWith(" ") -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw "Unsafe Windows file name"}}
  if([IO.Path]::IsPathRooted($file.path) -or ($file.path.Replace([char]92,[char]47).Split([char]47) -contains "..")){throw "Unsafe bundle path"}
  $target=[IO.Path]::GetFullPath((Join-Path $bundleRoot $file.path))
  if(-not $target.StartsWith($bundleRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Bundle path escapes its root"}
  $item=Get-Item -LiteralPath $target
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Bundle links are not allowed"}
  $parent=$item.Directory
  while($parent -and $parent.FullName.Length -ge $bundleRoot.Length){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Bundle parent links are not allowed"};if($parent.FullName -eq $bundleRoot){break};$parent=$parent.Parent}
  if($item.Length -ne $file.size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw "Component hash mismatch: $($file.path)"}
}
if(Test-Path -LiteralPath $installTarget){throw "Existing installation requires the versioned update path"}
New-Item -ItemType Directory -Path $installTarget | Out-Null
try{
  foreach($file in $manifest.files){$destination=Join-Path $installTarget $file.path;New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $bundleRoot $file.path) -Destination $destination}
  Copy-Item -LiteralPath (Join-Path $bundleRoot "manifest.json") -Destination (Join-Path $installTarget "manifest.json")
  foreach($file in $manifest.files){$destination=Join-Path $installTarget $file.path;if((Get-Item -LiteralPath $destination).Length -ne $file.size -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw "Installed component verification failed"}}
  & (Join-Path $installTarget "python/python.exe") -X utf8 (Join-Path $installTarget "distribution/runtime.py") setup --runtime-root $installTarget --data-root $dataTarget
  if($LASTEXITCODE -notin @(0,2)){throw "Runtime setup failed"}
  $installation=Get-Content -LiteralPath (Join-Path $dataTarget "installation.json") -Raw|ConvertFrom-Json
  Copy-Item -LiteralPath (Join-Path $installTarget "distribution/launcher.ps1") -Destination (Join-Path $installTarget "lessonloop.ps1")
  @{installationId=$installation.installationId;runtimeRoot=$installTarget;dataRoot=$dataTarget;manifestDigest=(Get-FileHash -LiteralPath (Join-Path $installTarget "manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $installTarget "active.json") -Encoding UTF8
  Write-Output "Installed runtime. Use lessonloop.ps1 start, status and doctor; configure learning and host scope before work."
  exit 2
}catch{Write-Error $_;exit 1}
