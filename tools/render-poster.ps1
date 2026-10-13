param(
    # A Chromium-based browser; Edge ships with Windows, so the default needs nothing installed.
    [string]$Browser
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root '.github/assets'
$page = (Resolve-Path (Join-Path $assets 'poster/poster.html')).Path
$exe = @(
    $Browser,
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $exe) { throw 'no Edge or Chrome found; pass -Browser <path>' }

# The design is 1280x640. The README banner is the same page at 1.25x, so its text stays sharp.
$targets = @(
    @{ Lang = 'zh'; Out = 'poster-zh.png'; Scale = 1.25; Width = 1600; Height = 800 },
    @{ Lang = 'en'; Out = 'poster-en.png'; Scale = 1.25; Width = 1600; Height = 800 },
    @{ Lang = 'zh'; Out = 'social-preview-zh.png'; Scale = 1; Width = 1280; Height = 640 },
    @{ Lang = 'en'; Out = 'social-preview-en.png'; Scale = 1; Width = 1280; Height = 640 }
)
$profile = Join-Path ([IO.Path]::GetTempPath()) 'droidbridge-poster-profile'
foreach ($target in $targets) {
    $out = Join-Path $assets $target.Out
    $url = ([Uri]$page).AbsoluteUri + '#' + $target.Lang
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out }
    # The window is taller than the design: a headless window's viewport is smaller than the size
    # asked for, so the capture is cropped to the design afterwards instead of trusting it.
    $raw = Join-Path ([IO.Path]::GetTempPath()) "droidbridge-poster-$($target.Out)"
    if (Test-Path -LiteralPath $raw) { Remove-Item -LiteralPath $raw }
    & $exe --headless=new --disable-gpu --hide-scrollbars "--user-data-dir=$profile" `
        "--force-device-scale-factor=$($target.Scale)" --window-size=1280,800 `
        --virtual-time-budget=4000 "--screenshot=$raw" $url 2>&1 | Out-Null
    if (-not (Test-Path -LiteralPath $raw)) { throw "$($target.Out) was not rendered" }
    $source = [System.Drawing.Bitmap]::new($raw)
    try {
        if ($source.Width -lt $target.Width -or $source.Height -lt $target.Height) {
            throw "$($target.Out) capture is $($source.Width)x$($source.Height), smaller than the design"
        }
        $rect = [System.Drawing.Rectangle]::new(0, 0, $target.Width, $target.Height)
        $cropped = $source.Clone($rect, $source.PixelFormat)
        try { $cropped.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $cropped.Dispose() }
    } finally { $source.Dispose(); Remove-Item -LiteralPath $raw }
    $header = [IO.File]::ReadAllBytes($out)[16..23]
    $width = [int]($header[0] * 16777216 + $header[1] * 65536 + $header[2] * 256 + $header[3])
    $height = [int]($header[4] * 16777216 + $header[5] * 65536 + $header[6] * 256 + $header[7])
    if ($width -ne $target.Width -or $height -ne $target.Height) {
        throw "$($target.Out) is ${width}x${height}, expected $($target.Width)x$($target.Height)"
    }
    Write-Output "rendered $($target.Out) ${width}x${height}"
}
