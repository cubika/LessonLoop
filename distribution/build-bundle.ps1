param([Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$PythonBase,[Parameter(Mandatory=$true)][string]$SitePackages,[Parameter(Mandatory=$true)][string]$Postgres,[Parameter(Mandatory=$true)][string]$Models)
$ErrorActionPreference="Stop"
$repoRoot=Split-Path $PSScriptRoot -Parent
$bundleRoot=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $bundleRoot){throw "Destination must be new"}
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
foreach($name in @("node","python","postgres","models","distribution","dist","node_modules","config","third-party")){New-Item -ItemType Directory -Path (Join-Path $bundleRoot $name)|Out-Null}
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $bundleRoot "node/node.exe")
function Copy-Tree([string]$Source,[string]$Target){& robocopy $Source $Target /E /MT:16 /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD __pycache__;if($LASTEXITCODE -ge 8){throw "Component copy failed"}}
Copy-Tree $PythonBase (Join-Path $bundleRoot "python")
Copy-Tree $SitePackages (Join-Path $bundleRoot "python/Lib/site-packages")
Copy-Tree $Postgres (Join-Path $bundleRoot "postgres")
Copy-Tree $Models (Join-Path $bundleRoot "models")
foreach($name in @("distribution","dist","node_modules","config","third-party")){Copy-Item -Path (Join-Path $repoRoot "$name/*") -Destination (Join-Path $bundleRoot $name) -Recurse}
Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination (Join-Path $bundleRoot "package.json")
$files=Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | ForEach-Object {
  $relative=$_.FullName.Substring($bundleRoot.Length+1).Replace([char]92,[char]47)
  @{path=$relative;size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$components=Get-Content -LiteralPath (Join-Path $bundleRoot "config/components.json") -Raw | ConvertFrom-Json
$manifest=@{compatibility=@{productSchema=1;protocol=1;activationCheck=1;hindsight=$components.hindsight;postgresql=$components.postgresql;pgvector=$components.pgvector};version="0.0.1-dev";platform="win32-x64";releaseReady=$false;createdAt=[DateTime]::UtcNow.ToString("o");files=@($files)}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $bundleRoot "manifest.json") -Encoding UTF8
Write-Output "Bundle prepared. It remains a development build until installation and product acceptance pass."
