param(
    [Parameter(Mandatory = $true)]
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$Version = '2026.10.3'
$Url = "https://github.com/cloudflare/cloudflared/releases/download/$Version/cloudflared-linux-arm64"
$ExpectedSha256 = '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8'

$root = Split-Path $PSScriptRoot -Parent
$cacheDir = Join-Path $root '.gradle\cloudflared-cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$cached = Join-Path $cacheDir "cloudflared-linux-arm64-$Version"

function Get-FileSha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

if (Test-Path $cached) {
    $actual = Get-FileSha256 $cached
    if ($actual -ne $ExpectedSha256) {
        Remove-Item -Force $cached
    }
}

if (-not (Test-Path $cached)) {
    Write-Output "Downloading cloudflared $Version linux-arm64"
    Invoke-WebRequest -Uri $Url -OutFile $cached -UseBasicParsing
}

$actual = Get-FileSha256 $cached
if ($actual -ne $ExpectedSha256) {
    throw "cloudflared SHA-256 mismatch: expected $ExpectedSha256 got $actual"
}

$destDir = Join-Path $OutDir 'arm64-v8a'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = Join-Path $destDir 'libcloudflared.so'
Copy-Item -Force $cached $dest
Write-Output "Installed libcloudflared.so ($Version) into $destDir"
