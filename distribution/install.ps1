param([Parameter(Mandatory=$true)][string]$Bundle,[string]$InstallRoot=(Join-Path $env:LOCALAPPDATA "LessonLoopRuntime"),[string]$DataRoot=(Join-Path $env:LOCALAPPDATA "LessonLoop"),[switch]$AllowDevelopmentBuild,[string[]]$AllowRoot=@(),[int]$BasePort=19431,[string]$PythonPath,[string]$NodePath,[string]$PostgresPath,[string]$ModelCache,[switch]$NonInteractive)
$ErrorActionPreference="Stop"
$utf8=New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
$OutputEncoding=$utf8
$bundleRoot=(Resolve-Path -LiteralPath $Bundle).Path
$installTarget=[IO.Path]::GetFullPath($InstallRoot)
$dataTarget=[IO.Path]::GetFullPath($DataRoot)
if($installTarget -eq [IO.Path]::GetPathRoot($installTarget) -or $dataTarget -eq [IO.Path]::GetPathRoot($dataTarget)){throw "Root directories are not valid targets"}
if($installTarget -eq $dataTarget){throw "Program and data directories must differ"}
$checkedDirectories=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
function Assert-UnlinkedDirectory([string]$Path){
  $ancestor=$Path
  while($ancestor -and -not $checkedDirectories.Contains($ancestor)){
    if([IO.Directory]::Exists($ancestor) -or [IO.File]::Exists($ancestor)){
      if([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint){throw "Installation path is a reparse point"}
      [void]$checkedDirectories.Add($ancestor)
    }
    $parent=[IO.Path]::GetDirectoryName($ancestor)
    if($parent -eq $ancestor){break};$ancestor=$parent
  }
}
foreach($targetRoot in @($bundleRoot,$installTarget,$dataTarget)){Assert-UnlinkedDirectory $targetRoot}
if($installTarget.StartsWith($dataTarget+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $dataTarget.StartsWith($installTarget+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Program and data roots cannot contain each other"}
$installParent=Split-Path $installTarget -Parent
if([IO.Directory]::Exists($installTarget) -and -not [IO.File]::Exists([IO.Path]::Combine($installTarget,"install-state.json")) -and -not [IO.File]::Exists([IO.Path]::Combine($installTarget,"active.json"))){throw "Existing unowned installation directory; choose an empty InstallRoot"}
New-Item -ItemType Directory -Path $installParent -Force|Out-Null
$installLockPath=$installTarget+".install.lock"
$installLock=[IO.File]::Open($installLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$hasher=[Security.Cryptography.SHA256]::Create()
function File-Digest([string]$Path){
  $stream=[IO.File]::OpenRead($Path)
  try{return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-","").ToLowerInvariant()}finally{$stream.Dispose()}
}
function Check-File([string]$Path,$Expected){
  $item=New-Object IO.FileInfo $Path
  if(-not $item.Exists -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Missing or linked component: $Path"}
  Assert-UnlinkedDirectory $item.DirectoryName
  if($item.Length -ne $Expected.size -or (File-Digest $Path) -ne $Expected.sha256){throw "Component hash mismatch: $($Expected.path)"}
}
function Save-Json([string]$Path,$Value){
  $temporary=$Path+".tmp"
  foreach($candidate in @($Path,$temporary)){if([IO.File]::Exists($candidate) -and [IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint){throw "Installation record path is linked"}}
  $Value|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Prepare-Models([string]$Python){
  if($manifest.modelPolicy -ne 'download_on_install'){return}
  $modelArgs=@('--runtime',$installTarget,'--reuse',$bundleRoot)
  if($ModelCache){$modelArgs+=@('--cache',$ModelCache)}
  & $Python -E -s -B -X utf8 (Join-Path $installTarget 'distribution/model_assets.py') @modelArgs
  if($LASTEXITCODE -ne 0){throw 'Model preparation failed; rerun the installer to reuse completed downloads'}
}
try{
$manifestPath=[IO.Path]::Combine($bundleRoot,"manifest.json")
if([IO.File]::GetAttributes($manifestPath) -band [IO.FileAttributes]::ReparsePoint){throw "Manifest is linked"}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
$manifestDigest=File-Digest $manifestPath
if($manifest.platform -ne "win32-x64" -or -not [Environment]::Is64BitOperatingSystem){throw "Windows x64 is required"}
$acceptedAlpha=$manifest.channel -eq "alpha" -and $manifest.alphaReady -eq $true -and $manifest.version -match "-alpha\."
if(-not $manifest.releaseReady -and -not $acceptedAlpha -and -not $AllowDevelopmentBuild){throw "This bundle has not passed its declared release channel checks"}
$systemReuse=$manifest.runtimePolicy -eq "system_reuse"
Write-Output $(if($systemReuse){"Checking existing Python, Node.js and PostgreSQL. Missing or old dependencies require your confirmation."}else{"Legacy bundle: using its included runtimes."})
$seenPaths=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
if(-not $manifest.files.Count){throw "Empty bundle manifest"}
foreach($file in $manifest.files){
  if(-not $seenPaths.Add($file.path.Replace([char]92,[char]47)) -or $file.path -eq "manifest.json"){throw "Duplicate manifest path"}
  if($file.path.Contains(":")){throw "Alternate stream or absolute path rejected"}
  foreach($part in $file.path.Replace([char]92,[char]47).Split([char]47)){if($part -in @("",".","..") -or $part.EndsWith(".") -or $part.EndsWith(" ") -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw "Unsafe Windows file name"}}
  if([IO.Path]::IsPathRooted($file.path) -or ($file.path.Replace([char]92,[char]47).Split([char]47) -contains "..")){throw "Unsafe bundle path"}
  $target=[IO.Path]::GetFullPath([IO.Path]::Combine($bundleRoot,$file.path))
  if(-not $target.StartsWith($bundleRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Bundle path escapes its root"}
  Check-File $target $file
}
  $requiredFiles=@("distribution/runtime.py","distribution/launcher.ps1","distribution/check_runtime.py","dist/cli/main.js","config/components.json")
  if($systemReuse){$requiredFiles+=@("distribution/dependencies.ps1","distribution/python_environment.py","config/python-requirements.txt")}else{$requiredFiles+=@("python/python.exe","node/node.exe")}
  if($manifest.modelPolicy -eq 'download_on_install'){$requiredFiles+='distribution/model_assets.py';if(-not $manifest.modelComponents.Count){throw 'Required model components missing'}}
  foreach($required in $requiredFiles){
    if(-not $seenPaths.Contains($required)){throw "Required runtime component missing: $required"}
  }
  $bundleBytes=[long]0
  foreach($file in $manifest.files){$bundleBytes += [long]$file.size}
  $programDrive=New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($installTarget))
  $dataDrive=New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($dataTarget))
  # The source bundle already occupies disk. Reserve a full installed copy and
  # 512 MiB for initial private database files, not an estimate of future usage.
  $reserve=[long](512MB)
  $programRequired=$bundleBytes
  if($programDrive.Name -eq $dataDrive.Name){$programRequired += $reserve}
  if($programDrive.AvailableFreeSpace -lt $programRequired){throw "Insufficient free space on installation drive; need $programRequired bytes for installation and initial data"}
  if($programDrive.Name -ne $dataDrive.Name -and $dataDrive.AvailableFreeSpace -lt $reserve){throw "Insufficient free space on data drive; need $reserve bytes for initial data"}
  $statePath=[IO.Path]::Combine($installTarget,"install-state.json")
  $activePath=[IO.Path]::Combine($installTarget,"active.json")
  $existingRecord=[IO.Path]::Combine($dataTarget,"installation.json")
  $previous=$null;$priorState=$null
  if([IO.File]::Exists($statePath)){
    if([IO.File]::GetAttributes($statePath) -band [IO.FileAttributes]::ReparsePoint){throw "Installation state is linked"}
    $priorState=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
    if($priorState.programRoot -ne $installTarget -or $priorState.dataRoot -ne $dataTarget -or $priorState.manifestDigest -ne $manifestDigest){throw "Interrupted installation belongs to a different bundle or data root"}
  }
  if([IO.File]::Exists($existingRecord)){
    if([IO.File]::GetAttributes($existingRecord) -band [IO.FileAttributes]::ReparsePoint){throw "Installation record is linked"}
    $previous=Get-Content -LiteralPath $existingRecord -Raw -Encoding UTF8|ConvertFrom-Json
    if($previous.dataRoot -ne $dataTarget -or $previous.runtimeRoot -ne $installTarget -or ($previous.programRoot -and $previous.programRoot -ne $installTarget)){throw "Existing data belongs to a different installation"}
    if($previous.setupState -notin @("ready","purged","initializing")){throw "Existing data requires recovery"}
    if($previous.manifestDigest -ne $manifestDigest -and -not ($priorState -and -not $previous.manifestDigest)){throw "Existing data requires the same bundle; use the compatible update path"}
    if($priorState.installationId -and $priorState.installationId -ne $previous.installationId){throw "Interrupted installation identity mismatch"}
  }
  if([IO.File]::Exists($activePath)){
    if([IO.File]::GetAttributes($activePath) -band [IO.FileAttributes]::ReparsePoint){throw "Active installation record is linked"}
    $active=Get-Content -LiteralPath $activePath -Raw -Encoding UTF8|ConvertFrom-Json
    if(-not $previous -or $active.installationId -ne $previous.installationId -or $active.dataRoot -ne $dataTarget -or $active.runtimeRoot -ne $installTarget -or $active.manifestDigest -ne $manifestDigest){throw "Existing installation requires the versioned update path"}
    if(-not [IO.File]::Exists([IO.Path]::Combine($installTarget,"manifest.json")) -or (File-Digest ([IO.Path]::Combine($installTarget,"manifest.json"))) -ne $manifestDigest){throw "Installed manifest changed"}
    foreach($file in $manifest.files){Check-File ([IO.Path]::Combine($installTarget,$file.path)) $file}
    $launcherEntry=@($manifest.files|Where-Object {$_.path -eq "distribution/launcher.ps1"})[0]
    Check-File ([IO.Path]::Combine($installTarget,"lessonloop.ps1")) $launcherEntry
    if($systemReuse){
      . (Join-Path $bundleRoot "distribution/dependencies.ps1")
      if(-not $PythonPath -and (Test-Path -LiteralPath $previous.pythonBase -PathType Leaf)){$PythonPath=$previous.pythonBase}
      if(-not $NodePath -and (Test-Path -LiteralPath $previous.runtimeExecutables.node -PathType Leaf)){$NodePath=$previous.runtimeExecutables.node}
      $dependencies=Resolve-LessonLoopDependencies -PythonPath $PythonPath -NodePath $NodePath -PostgresPath $previous.runtimeExecutables.postgres -NonInteractive:$NonInteractive
      if($dependencies.PostgresNeedsComponent -or $dependencies.PostgresPath -ne $previous.runtimeExecutables.postgres){throw "The installed database runtime is unavailable. Restore its recorded PostgreSQL installation before retrying."}
      Prepare-Models $dependencies.PythonExe
      & $dependencies.PythonExe -E -s -B -X utf8 (Join-Path $installTarget "distribution/python_environment.py") --python $dependencies.PythonExe --runtime $installTarget
      if($LASTEXITCODE -ne 0){throw "Python application packages could not be repaired; rerun this installer after resolving the reported error"}
      $previous.pythonBase=$dependencies.PythonExe
      $previous.runtimeExecutables.node=$dependencies.NodeExe
      Save-Json $existingRecord $previous
    }
    if($priorState){Remove-Item -LiteralPath $statePath -Force}
    Write-Output "LessonLoop $($manifest.version) is already installed at $installTarget."
    exit 2
  }
  if([IO.Directory]::Exists($installTarget) -and -not $priorState){throw "Existing unowned installation directory; choose an empty InstallRoot"}
  $dependencies=$null
  if($systemReuse){
    . (Join-Path $bundleRoot "distribution/dependencies.ps1")
    if($previous.runtimeExecutables){
      if(-not $PythonPath -and (Test-Path -LiteralPath $previous.pythonBase -PathType Leaf)){$PythonPath=$previous.pythonBase}
      if(-not $NodePath -and (Test-Path -LiteralPath $previous.runtimeExecutables.node -PathType Leaf)){$NodePath=$previous.runtimeExecutables.node}
      $PostgresPath=$previous.runtimeExecutables.postgres
    }
    $dependencyArgs=@{NonInteractive=$NonInteractive}
    if($PythonPath){$dependencyArgs.PythonPath=$PythonPath};if($NodePath){$dependencyArgs.NodePath=$NodePath};if($PostgresPath){$dependencyArgs.PostgresPath=$PostgresPath}
    $dependencies=Resolve-LessonLoopDependencies @dependencyArgs
    if($dependencies.PostgresNeedsComponent){
      throw "PostgreSQL installation was approved but no compatible component is available locally. Use the online install.ps1 or provide -PostgresPath after installation."
    }
  }
  [IO.Directory]::CreateDirectory($installTarget)|Out-Null
  Save-Json $statePath @{programRoot=$installTarget;dataRoot=$dataTarget;manifestDigest=$manifestDigest;installationId=$previous.installationId}
  foreach($file in $manifest.files){
    $destination=[IO.Path]::Combine($installTarget,$file.path)
    $directory=[IO.Path]::GetDirectoryName($destination)
    Assert-UnlinkedDirectory $directory
    if([IO.File]::Exists($destination) -and [IO.File]::GetAttributes($destination) -band [IO.FileAttributes]::ReparsePoint){throw "Installed component is linked"}
    [IO.Directory]::CreateDirectory($directory)|Out-Null
    [IO.File]::Copy([IO.Path]::Combine($bundleRoot,$file.path),$destination,$true)
  }
  $installedManifest=[IO.Path]::Combine($installTarget,"manifest.json")
  if([IO.File]::Exists($installedManifest) -and [IO.File]::GetAttributes($installedManifest) -band [IO.FileAttributes]::ReparsePoint){throw "Installed manifest is linked"}
  [IO.File]::Copy($manifestPath,$installedManifest,$true)
  foreach($file in $manifest.files){Check-File ([IO.Path]::Combine($installTarget,$file.path)) $file}
  $setupArguments=@("setup","--runtime-root",$installTarget,"--data-root",$dataTarget,"--base-port",$BasePort)
  foreach($allowed in $AllowRoot){$setupArguments+=@("--allow-root",$allowed)}
  $runtimePython=Join-Path $installTarget "python/python.exe"
  if($systemReuse){
    Prepare-Models $dependencies.PythonExe
    & $dependencies.PythonExe -E -s -B -X utf8 (Join-Path $installTarget "distribution/python_environment.py") --python $dependencies.PythonExe --runtime $installTarget
    if($LASTEXITCODE -ne 0){throw "Python application packages could not be prepared; existing system Python and Node.js were not changed"}
    $runtimePython=Join-Path $installTarget ".venv/Scripts/python.exe"
    $setupArguments+=@("--python-base",$dependencies.PythonExe,"--node-executable",$dependencies.NodeExe,"--postgres-root",$dependencies.PostgresPath)
  }
  if(-not $previous -or $previous.setupState -ne "ready"){
    & $runtimePython -E -s -B -X utf8 (Join-Path $installTarget "distribution/runtime.py") @setupArguments
    if($LASTEXITCODE -notin @(0,2)){throw "Runtime setup failed; rerun this installer with the same bundle and directories"}
  }
  $installation=Get-Content -LiteralPath (Join-Path $dataTarget "installation.json") -Raw -Encoding UTF8|ConvertFrom-Json
  $installation|Add-Member -NotePropertyName manifestDigest -NotePropertyValue $manifestDigest -Force
  Save-Json $existingRecord $installation
  Copy-Item -LiteralPath (Join-Path $installTarget "distribution/launcher.ps1") -Destination (Join-Path $installTarget "lessonloop.ps1")
  Save-Json $activePath @{installationId=$installation.installationId;runtimeRoot=$installTarget;dataRoot=$dataTarget;manifestDigest=$manifestDigest}
  Remove-Item -LiteralPath $statePath -Force
  Write-Output "Installed LessonLoop $($manifest.version). Run lessonloop.ps1 start, configure --allow-root <project> --enable-learning, agent install, then ui. Copilot CLI must be installed and signed in."
  exit 2
}catch{Write-Error $_;exit 1}finally{
  $hasher.Dispose();$installLock.Dispose()
  # Keep the empty sibling lock file so a concurrent installer cannot race file deletion.
}
