# Dot-source this file. Discovery is read-only; installs require an explicit yes.
function Invoke-LessonLoopProbe([string]$Path,[string[]]$Arguments){
  $saved=@{}
  foreach($name in @('NODE_OPTIONS','NODE_PATH')){
    $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
  try {
    $output=& $Path @Arguments 2>$null
    if($LASTEXITCODE -ne 0){throw "Dependency probe failed: $Path"}
    return ($output -join [Environment]::NewLine).Trim()
  } finally {
    foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
  }
}

function Get-LessonLoopPythonCandidates([string]$Path){
  if($Path){return $Path}
  $paths=@(Get-Command python.exe,python3.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object {$_.Source})
  $launcher=Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if($launcher){
    try {
      $listing=Invoke-LessonLoopProbe $launcher.Source @('-0p')
      foreach($line in ($listing -split '\r?\n')){if($line -match '([A-Za-z]:\\.*python(?:[0-9.]*)?\.exe)\s*$'){$paths+=$Matches[1].Trim()}}
    } catch {}
  }
  foreach($parent in @($env:ProgramFiles,(Join-Path $env:LOCALAPPDATA 'Programs/Python'))){
    if($parent -and (Test-Path -LiteralPath $parent)){
      $paths+=@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'Python*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'python.exe'} | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf})
    }
  }
  # uv-managed interpreters need not be on PATH or registered with py.exe.
  foreach($parent in @($env:UV_PYTHON_INSTALL_DIR,(Join-Path $env:APPDATA 'uv/python'))){
    if($parent -and (Test-Path -LiteralPath $parent)){
      $paths+=@(Get-ChildItem -LiteralPath $parent -Directory -Filter 'cpython-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'python.exe'} | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf})
    }
  }
  return $paths | Select-Object -Unique
}

function Get-LessonLoopNodeCandidates([string]$Path){
  if($Path){return $Path}
  $paths=@(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object {$_.Source})
  foreach($parent in @($env:ProgramFiles,$env:LOCALAPPDATA)){
    if($parent){$candidate=Join-Path $parent 'nodejs/node.exe';if(Test-Path -LiteralPath $candidate -PathType Leaf){$paths+=$candidate}}
  }
  return $paths | Select-Object -Unique
}

function Get-LessonLoopPostgresCandidates([string]$Path){
  if($Path){return $Path}
  $paths=@(Get-Command postgres.exe,pg_config.exe -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object {Split-Path (Split-Path $_.Source -Parent) -Parent})
  if($env:ProgramFiles){
    $parent=Join-Path $env:ProgramFiles 'PostgreSQL'
    if(Test-Path -LiteralPath $parent){$paths+=@(Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {$_.FullName})}
  }
  $components=Join-Path $env:LOCALAPPDATA 'LessonLoopComponents'
  if(Test-Path -LiteralPath $components){
    $paths+=@(Get-ChildItem -LiteralPath $components -Directory -Filter 'postgresql-*' -ErrorAction SilentlyContinue | Where-Object {$_.Name -notlike '*.staging-*'} | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'postgres'} | Where-Object {Test-Path -LiteralPath $_ -PathType Container})
  }
  return $paths | Select-Object -Unique
}

function Test-LessonLoopPython([string]$Path){
  $result=[pscustomobject]@{Path=$Path;Version=$null;Compatible=$false;Reason='Python could not be started'}
  try {
    $info=Invoke-LessonLoopProbe $Path @('-I','-c','import json,sys,sysconfig; print(json.dumps(dict(version=''.''.join(map(str,sys.version_info[:3])),arch=sysconfig.get_platform(),path=sys._base_executable)))') | ConvertFrom-Json
    $result.Version=$info.version
    $result.Path=$info.path
    if([version]$info.version -lt [version]'3.11.0'){$result.Reason='Python 3.11 or newer is required'}
    elseif($info.arch -ne 'win-amd64'){$result.Reason='Python x64 is required'}
    else {$result.Compatible=$true;$result.Reason=$null}
  } catch {$result.Reason=$_.Exception.Message}
  return $result
}

function Test-LessonLoopNode([string]$Path){
  $result=[pscustomobject]@{Path=$Path;Version=$null;Compatible=$false;Reason='Node.js could not be started'}
  try {
    $info=Invoke-LessonLoopProbe $Path @('-p','JSON.stringify({version:process.versions.node,arch:process.arch,path:process.execPath})') | ConvertFrom-Json
    $result.Version=$info.version
    $result.Path=$info.path
    if([version]$info.version -lt [version]'18.14.1'){$result.Reason='Node.js 18.14.1 or newer is required'}
    elseif($info.arch -ne 'x64'){$result.Reason='Node.js x64 is required'}
    else {$result.Compatible=$true;$result.Reason=$null}
  } catch {$result.Reason=$_.Exception.Message}
  return $result
}

function Test-LessonLoopPostgresRuntime([string]$Path){
  $result=[pscustomobject]@{Path=$Path;Version=$null;PgvectorVersion=$null;Compatible=$false;Reason=$null}
  try {
    $result.Path=[IO.Path]::GetFullPath($Path)
    foreach($binary in @('postgres','initdb','pg_ctl','pg_dump')){
      if(-not (Test-Path -LiteralPath (Join-Path $Path "bin/$binary.exe") -PathType Leaf)){throw "PostgreSQL binary missing: $binary.exe"}
    }
    $executable=Join-Path $Path 'bin/postgres.exe'
    $reader=New-Object IO.BinaryReader ([IO.File]::OpenRead($executable))
    try {
      if($reader.ReadUInt16() -ne 0x5a4d){throw 'PostgreSQL executable is invalid'}
      $reader.BaseStream.Position=0x3c
      $offset=$reader.ReadInt32()
      if($offset -lt 0 -or $offset -gt $reader.BaseStream.Length-6){throw 'PostgreSQL executable is invalid'}
      $reader.BaseStream.Position=$offset
      if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'PostgreSQL x64 is required'}
    } finally {$reader.Dispose()}
    $version=Invoke-LessonLoopProbe $executable @('--version')
    if($version -notmatch 'PostgreSQL\)\s+(\d+)(?:\.(\d+))?'){throw 'Cannot read PostgreSQL version'}
    $result.Version=$Matches[1]+'.'+$(if($Matches[2]){$Matches[2]}else{'0'})
    if([version]$result.Version -lt [version]'15.0'){throw 'PostgreSQL 15 or newer is required'}
    $share=Join-Path $Path 'share';$library=Join-Path $Path 'lib'
    $pgConfig=Join-Path $Path 'bin/pg_config.exe'
    if(Test-Path -LiteralPath $pgConfig -PathType Leaf){
      $share=Invoke-LessonLoopProbe $pgConfig @('--sharedir')
      $library=Invoke-LessonLoopProbe $pgConfig @('--pkglibdir')
    }
    foreach($extension in @('vector','pg_trgm')){
      $control=Join-Path $share "extension/$extension.control"
      if(-not (Test-Path -LiteralPath $control -PathType Leaf)){throw "PostgreSQL extension missing: $extension"}
      $definition=Get-Content -LiteralPath $control -Raw
      if($definition -notmatch "(?m)^\s*default_version\s*=\s*'([^']+)'"){throw "Cannot read $extension extension version"}
      $extensionVersion=$Matches[1]
      if($extension -eq 'vector'){
        $result.PgvectorVersion=$extensionVersion
        if([version]$extensionVersion -lt [version]'0.5.0'){throw 'pgvector 0.5.0 or newer is required'}
      }
      # PostgreSQL may install a base script and then apply bundled updates.
      $scripts=@(Get-ChildItem -LiteralPath (Join-Path $share 'extension') -File -Filter "$extension--*.sql" | Where-Object {$_.BaseName -match ('^'+[regex]::Escape($extension)+'--[^-]+$')})
      if(-not $scripts.Count){throw "PostgreSQL extension SQL missing: $extension"}
      if(-not (Test-Path -LiteralPath (Join-Path $library "$extension.dll") -PathType Leaf)){throw "PostgreSQL extension DLL missing: $extension"}
    }
    $result.Compatible=$true
  } catch {$result.Reason=$_.Exception.Message}
  return $result
}

function Confirm-LessonLoopDependency([string]$Message,[switch]$NonInteractive){
  if($NonInteractive){throw "$Message Rerun interactively to approve this change, or install the dependency yourself."}
  try {$answer=Read-Host "$Message [y/N]"} catch {throw 'Dependency installation requires interactive confirmation'}
  if($answer -notmatch '^(?i:y|yes)$'){throw 'Dependency change declined; installation stopped'}
}

function Install-LessonLoopDependency([string]$Name){
  $package=if($Name -eq 'Python'){'Python.Python.3.12'}else{'OpenJS.NodeJS.LTS'}
  $link=if($Name -eq 'Python'){'https://www.python.org/downloads/windows/'}else{'https://nodejs.org/en/download'}
  $winget=Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if(-not $winget){throw "winget is unavailable. Install $Name x64 from $link and rerun LessonLoop installation."}
  # winget presents its own source/package agreements. No agreement is pre-accepted.
  & $winget.Source install --id $package --exact --source winget --architecture x64 --interactive | Out-Host
  if($LASTEXITCODE -ne 0){throw "$Name installation failed (winget exit $LASTEXITCODE). Install from $link and rerun."}
  $env:PATH=([Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User'),$env:PATH) -join ';'
}

function Resolve-LessonLoopDependencies {
  param([string]$PythonPath,[string]$NodePath,[string]$PostgresPath,[string]$PostgresComponentPath,[switch]$NonInteractive)
  $python=$null;$node=$null;$postgres=$null
  foreach($name in @('Python','Node')){
    $path=if($name -eq 'Python'){$PythonPath}else{$NodePath}
    $candidates=@(& ('Get-LessonLoop'+$name+'Candidates') $path)
    $found=@(foreach($candidate in $candidates){& ("Test-LessonLoop$name") $candidate})
    $selected=$found | Where-Object Compatible | Select-Object -First 1
    if(-not $selected){
      $requirement=if($name -eq 'Python'){'Python >= 3.11 x64'}else{'Node.js >= 18.14.1 x64'}
      $action=if($found.Count){
        foreach($item in $found){Write-Host "$($item.Path): $($item.Reason)"}
        "Upgrade $name to meet $requirement using winget?"
      }else{"$name was not found. Install $requirement using winget?"}
      Confirm-LessonLoopDependency $action -NonInteractive:$NonInteractive
      Install-LessonLoopDependency $name
      $selected=@(foreach($candidate in (& ('Get-LessonLoop'+$name+'Candidates'))){& ("Test-LessonLoop$name") $candidate}) | Where-Object Compatible | Select-Object -First 1
      if(-not $selected){throw "$requirement was not found after installation. Open a new PowerShell window and rerun, or specify its executable path."}
    }
    Write-Host "Using $name $($selected.Version): $($selected.Path)"
    if($name -eq 'Python'){$python=$selected}else{$node=$selected}
  }
  $found=@(foreach($candidate in (Get-LessonLoopPostgresCandidates $PostgresPath)){Test-LessonLoopPostgresRuntime $candidate})
  $postgres=$found | Where-Object Compatible | Select-Object -First 1
  $needsComponent=$false
  if(-not $postgres){
    foreach($item in $found){Write-Host "$($item.Path): $($item.Reason)"}
    $action=if($found.Count){'Upgrade the PostgreSQL runtime for LessonLoop by installing a separate compatible component?'}else{'PostgreSQL was not found. Install the LessonLoop PostgreSQL component?'}
    Confirm-LessonLoopDependency "$action Requires PostgreSQL >= 15 x64, pgvector >= 0.5.0 and pg_trgm. Existing databases will not be changed." -NonInteractive:$NonInteractive
    if($PostgresComponentPath){
      $postgres=Test-LessonLoopPostgresRuntime $PostgresComponentPath
      if(-not $postgres.Compatible){throw "PostgreSQL component is incompatible: $($postgres.Reason)"}
    }else{$needsComponent=$true}
  }
  if($postgres){Write-Host "Using PostgreSQL $($postgres.Version): $($postgres.Path). LessonLoop keeps its own data directory."}
  return [pscustomobject]@{PythonExe=$python.Path;PythonVersion=$python.Version;NodeExe=$node.Path;NodeVersion=$node.Version;PostgresPath=$postgres.Path;PostgresVersion=$postgres.Version;PostgresNeedsComponent=$needsComponent}
}
