$ErrorActionPreference = 'Stop'
$probeWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$probeScript = Join-Path $probeWorkspace 'spikes/p0/host-probe.ts'
$probeNode = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$probeExitCode = 1

Push-Location -LiteralPath $probeWorkspace
try {
    & $probeNode.Source --import tsx $probeScript
    $probeExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $probeExitCode
