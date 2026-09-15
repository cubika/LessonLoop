param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA "LessonLoopRuntime"),[string]$DataRoot=(Join-Path $env:LOCALAPPDATA "LessonLoop"),[string[]]$AllowRoot=@(),[int]$BasePort=19431,[string]$PythonPath,[string]$NodePath,[string]$PostgresPath,[string]$ModelCache,[switch]$NonInteractive)
$ErrorActionPreference="Stop"
$version="0.1.0-alpha.3"
$asset="LessonLoop-$version-windows-x64.zip"
$base="https://github.com/cubika/LessonLoop/releases/download/v$version"
$staging=Join-Path ([IO.Path]::GetTempPath()) ("LessonLoop-download-"+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $staging | Out-Null
$archive=Join-Path $staging $asset
$checksumFile=Join-Path $staging "SHA256SUMS.txt"
Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $checksumFile
$checksums=Get-Content -LiteralPath $checksumFile -Raw -Encoding UTF8
function Get-CheckedAsset([string]$Name,[string]$Destination){
  $lines=@($checksums -split [char]10 | Where-Object { ($_.Trim() -split '\s+')[-1] -eq $Name })
  if($lines.Count -ne 1){throw "Release checksum missing: $Name"}
  $hash=($lines[0].Trim() -split '\s+')[0]
  if($hash -notmatch '^[a-fA-F0-9]{64}$'){throw "Invalid release checksum"}
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$Name" -OutFile $Destination
  if((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $hash){throw "Release checksum mismatch: $Name"}
}
$dependencyScript=Join-Path $staging "dependencies.ps1"
Get-CheckedAsset "dependencies.ps1" $dependencyScript
. $dependencyScript
$dependencyArgs=@{NonInteractive=$NonInteractive}
if($PythonPath){$dependencyArgs.PythonPath=$PythonPath};if($NodePath){$dependencyArgs.NodePath=$NodePath};if($PostgresPath){$dependencyArgs.PostgresPath=$PostgresPath}
$dependencies=Resolve-LessonLoopDependencies @dependencyArgs
if($dependencies.PostgresNeedsComponent){
  $component="LessonLoop-$version-postgresql-windows-x64.zip"
  $componentZip=Join-Path $staging $component
  Get-CheckedAsset $component $componentZip
  $componentRoot=Join-Path $env:LOCALAPPDATA "LessonLoopComponents/postgresql-18.1.0-pgvector-0.8.5"
  if(Test-Path -LiteralPath $componentRoot){throw "Component directory already exists. Select it explicitly with -PostgresPath if compatible."}
  $componentStaging=$componentRoot+'.staging-'+[Guid]::NewGuid().ToString()
  Expand-Archive -LiteralPath $componentZip -DestinationPath $componentStaging
  $checkedPostgres=Test-LessonLoopPostgresRuntime -Path (Join-Path $componentStaging 'postgres')
  if(-not $checkedPostgres.Compatible){throw "Downloaded PostgreSQL component failed compatibility checks"}
  # Activate only a complete component. An interrupted extraction can be retried.
  $componentParent=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LessonLoopComponents'))+[IO.Path]::DirectorySeparatorChar
  foreach($target in @($componentStaging,$componentRoot)){
    if(-not [IO.Path]::GetFullPath($target).StartsWith($componentParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Component path escapes its parent'}
  }
  Move-Item -LiteralPath $componentStaging -Destination $componentRoot
  $dependencies.PostgresPath=Join-Path $componentRoot 'postgres'
}
Write-Output "Downloading LessonLoop $version program files. Missing models will be downloaded separately during installation."
Get-CheckedAsset $asset $archive
$line=($checksums -split [char]10 | Where-Object { $_.Trim().EndsWith($asset) })
if(@($line).Count -ne 1){throw "Release checksum missing"}
$expected=($line.Trim() -split '\s+')[0]
if($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected){throw "Release archive checksum mismatch"}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach($entry in $zip.Entries){
    $parts=$entry.FullName.Replace([char]92,[char]47).Split([char]47)
    if([IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':') -or $parts -contains '..'){throw "Unsafe release archive path"}
    foreach($part in $parts){if($part -and ($part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)')){throw "Unsafe archive name"}}
  }
} finally { $zip.Dispose() }
$bundle=Join-Path $staging "bundle"
[IO.Compression.ZipFile]::ExtractToDirectory($archive,$bundle)
& (Join-Path $bundle "distribution/install.ps1") -Bundle $bundle -InstallRoot $InstallRoot -DataRoot $DataRoot -AllowRoot $AllowRoot -BasePort $BasePort -PythonPath $dependencies.PythonExe -NodePath $dependencies.NodeExe -PostgresPath $dependencies.PostgresPath -ModelCache $ModelCache -NonInteractive
$code=$LASTEXITCODE
Write-Output "Downloaded files remain at $staging and can be removed after installation."
exit $code
