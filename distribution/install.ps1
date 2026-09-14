param([Parameter(Mandatory=$true)][string]$Bundle,[string]$InstallRoot=(Join-Path $env:LOCALAPPDATA "LessonLoopRuntime"),[string]$DataRoot=(Join-Path $env:LOCALAPPDATA "LessonLoop"),[switch]$AllowDevelopmentBuild)
$ErrorActionPreference="Stop"
$bundleRoot=(Resolve-Path -LiteralPath $Bundle).Path
$installTarget=[IO.Path]::GetFullPath($InstallRoot)
$dataTarget=[IO.Path]::GetFullPath($DataRoot)
if($installTarget -eq [IO.Path]::GetPathRoot($installTarget) -or $dataTarget -eq [IO.Path]::GetPathRoot($dataTarget)){throw "Root directories are not valid targets"}
if($installTarget -eq $dataTarget){throw "Program and data directories must differ"}
$manifest=Get-Content -LiteralPath (Join-Path $bundleRoot "manifest.json") -Raw | ConvertFrom-Json
if($manifest.platform -ne "win32-x64" -or -not [Environment]::Is64BitOperatingSystem){throw "Windows x64 is required"}
if(-not $manifest.releaseReady -and -not $AllowDevelopmentBuild){throw "This bundle is a development build, not an accepted release"}
foreach($file in $manifest.files){
  if([IO.Path]::IsPathRooted($file.path) -or $file.path -match "(^|[\/])..([\/]|$)"){throw "Unsafe bundle path"}
  $target=[IO.Path]::GetFullPath((Join-Path $bundleRoot $file.path))
  if(-not $target.StartsWith($bundleRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Bundle path escapes its root"}
  $item=Get-Item -LiteralPath $target
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Bundle links are not allowed"}
  if($item.Length -ne $file.size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw "Component hash mismatch: $($file.path)"}
}
if(Test-Path -LiteralPath $installTarget){throw "Existing installation requires the versioned update path"}
New-Item -ItemType Directory -Path $installTarget | Out-Null
try{
  foreach($file in $manifest.files){$destination=Join-Path $installTarget $file.path;New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $bundleRoot $file.path) -Destination $destination}
  Copy-Item -LiteralPath (Join-Path $bundleRoot "manifest.json") -Destination (Join-Path $installTarget "manifest.json")
  & (Join-Path $installTarget "python/python.exe") -X utf8 (Join-Path $installTarget "distribution/runtime.py") setup --runtime-root $installTarget --data-root $dataTarget
  if($LASTEXITCODE -notin @(0,2)){throw "Runtime setup failed"}
  Write-Output "Installed development runtime. Configure and validate before using real work data."
  exit 2
}catch{Write-Error $_;exit 1}
