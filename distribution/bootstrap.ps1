param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA "LessonLoopRuntime"),[string]$DataRoot=(Join-Path $env:LOCALAPPDATA "LessonLoop"),[string[]]$AllowRoot=@(),[int]$BasePort=19431)
$ErrorActionPreference="Stop"
$version="0.1.0-alpha.1"
$asset="LessonLoop-$version-windows-x64.zip"
$base="https://github.com/cubika/LessonLoop/releases/download/v$version"
$staging=Join-Path ([IO.Path]::GetTempPath()) ("LessonLoop-download-"+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $staging | Out-Null
$archive=Join-Path $staging $asset
Write-Output "Downloading LessonLoop $version..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
$checksumFile=Join-Path $staging "SHA256SUMS.txt"
Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $checksumFile
$checksums=Get-Content -LiteralPath $checksumFile -Raw -Encoding UTF8
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
& (Join-Path $bundle "distribution/install.ps1") -Bundle $bundle -InstallRoot $InstallRoot -DataRoot $DataRoot -AllowRoot $AllowRoot -BasePort $BasePort
$code=$LASTEXITCODE
Write-Output "Downloaded files remain at $staging and can be removed after installation."
exit $code
