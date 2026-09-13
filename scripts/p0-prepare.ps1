param([switch]$SkipModel)
$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeDir = Join-Path $workspace ".p0/runtime"
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
function Get-VerifiedFile {
  param([string]$Uri, [string]$Target, [string]$Sha256)
  if (-not (Test-Path -LiteralPath $Target)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Invoke-WebRequest -Uri $Uri -OutFile $Target -TimeoutSec 120
  }
  $actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "Checksum mismatch: $Target" }
}
$releases = @(
  @{name="qdrant-1.19.1";archive="qdrant-1.19.1-windows.zip";url="https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-x86_64-pc-windows-msvc.zip";sha="9b6f69bd85f6abed4bc13f943099f55c6ffd55f5dd90388635320d8fbb569eb0"},
  @{name="copilot-1.0.83";archive="copilot-1.0.83-windows.zip";url="https://github.com/github/copilot-cli/releases/download/v1.0.83/copilot-win32-x64.zip";sha="0e07221a275fdf7e61619c53566e3a421fd646d74d8e9ca491dbbff221f22945"}
)
foreach ($release in $releases) {
  $archive = Join-Path $runtimeDir $release.archive
  Get-VerifiedFile -Uri $release.url -Target $archive -Sha256 $release.sha
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $runtimeDir $release.name) -Force
}
if (-not $SkipModel) {
  $modelDir = Join-Path $workspace ".p0/models/all-MiniLM-L6-v2"
  $modelFiles = @(
    @{name="config.json";sha="7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7"},
    @{name="tokenizer.json";sha="da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"},
    @{name="tokenizer_config.json";sha="9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"},
    @{name="onnx/model_quantized.onnx";sha="afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"}
  )
  foreach ($file in $modelFiles) {
    $uri = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/" + $file.name
    Get-VerifiedFile -Uri $uri -Target (Join-Path $modelDir $file.name) -Sha256 $file.sha
  }
}
Write-Output "P0 binaries and selected model verified under $workspace/.p0. No global installation performed."
