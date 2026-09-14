$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw 'The Copilot probe requires Windows x64.'
}

$probeWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$probeRuntime = Join-Path $probeWorkspace '.local-validation/copilot/runtime'
$probeVersion = '1.0.83'
$probeSha256 = '0e07221a275fdf7e61619c53566e3a421fd646d74d8e9ca491dbbff221f22945'
$probeArchive = Join-Path $probeRuntime "copilot-$probeVersion-windows.zip"
$probeDirectory = Join-Path $probeRuntime "copilot-$probeVersion"
$probeUrl = "https://github.com/github/copilot-cli/releases/download/v$probeVersion/copilot-win32-x64.zip"

New-Item -ItemType Directory -Path $probeRuntime -Force | Out-Null
if (-not (Test-Path -LiteralPath $probeArchive -PathType Leaf)) {
    Invoke-WebRequest -Uri $probeUrl -OutFile $probeArchive -TimeoutSec 120
}
$probeActualHash = (Get-FileHash -LiteralPath $probeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($probeActualHash -ne $probeSha256) {
    throw "Checksum mismatch: $probeArchive"
}
Expand-Archive -LiteralPath $probeArchive -DestinationPath $probeDirectory -Force
if (-not (Test-Path -LiteralPath (Join-Path $probeDirectory 'copilot.exe') -PathType Leaf)) {
    throw "The verified Copilot archive did not provide copilot.exe: $probeDirectory"
}
Write-Output "Copilot CLI $probeVersion prepared under $probeDirectory. No global installation performed."
