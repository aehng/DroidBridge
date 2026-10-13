param(
    # The device or emulator to capture from; adb's -s value.
    [Parameter(Mandatory = $true)][string]$Serial,
    [ValidateSet('zh', 'en', 'both')][string]$Language = 'both',
    [string]$Package = 'com.droidbridge.standalone',
    # Light theme instead of the default dark one.
    [switch]$Light
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$adb = { param([string[]]$Arguments) & adb -s $Serial @Arguments }

function Invoke-Shell([string]$Command) { & adb -s $Serial shell $Command | Out-Null }

# Pages are reached by tapping at fractions of the screen, never by reading the UI hierarchy: a
# running accessibility service makes `uiautomator dump` fail and leave an old file behind.
$size = (& adb -s $Serial shell wm size) -join ' '
if ($size -notmatch '(\d+)x(\d+)') { throw "cannot read the screen size: $size" }
$width = [int]$Matches[1]; $height = [int]$Matches[2]
function Tap([double]$x, [double]$y) {
    Invoke-Shell ("input tap {0} {1}" -f [int]($x * $width), [int]($y * $height))
    Start-Sleep -Milliseconds 1800
}
$navY = 0.970
$tabs = @{ Settings = 0.14; Home = 0.50; Automations = 0.84 }

function Save-Page([string]$Lang, [string]$Name) {
    $directory = Join-Path $root ".github/assets/screenshots/$Lang"
    New-Item -ItemType Directory -Force $directory | Out-Null
    $raw = Join-Path ([IO.Path]::GetTempPath()) "droidbridge-shot-$Lang-$Name.png"
    & cmd /c "adb -s $Serial exec-out screencap -p > `"$raw`""
    $source = [System.Drawing.Bitmap]::new($raw)
    try {
        $scaled = [System.Drawing.Bitmap]::new(540, [int][Math]::Round(540.0 * $source.Height / $source.Width))
        $graphics = [System.Drawing.Graphics]::FromImage($scaled)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($source, 0, 0, $scaled.Width, $scaled.Height)
        } finally { $graphics.Dispose() }
        try { $scaled.Save((Join-Path $directory "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png) } finally { $scaled.Dispose() }
    } finally { $source.Dispose(); Remove-Item -LiteralPath $raw }
    Write-Output "captured $Lang/$Name.png"
}

$tags = @{ zh = 'zh-CN'; en = 'en-US' }
$languages = if ($Language -eq 'both') { @('en', 'zh') } else { @($Language) }
$theme = if ($Light) { 'no' } else { 'yes' }
$previousNight = ((& adb -s $Serial shell cmd uimode night) -join ' ') -replace '.*:\s*', ''
Invoke-Shell "cmd uimode night $theme"
Invoke-Shell 'settings put global sysui_demo_allowed 1'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command enter'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0900'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command network -e mobile hide'
Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command notifications -e visible false'
try {
    foreach ($lang in $languages) {
        Invoke-Shell "cmd locale set-app-locales $Package --locales $($tags[$lang])"
        Invoke-Shell "monkey -p $Package -c android.intent.category.LAUNCHER 1"
        Start-Sleep -Seconds 4
        Tap $tabs.Home $navY
        Save-Page $lang 'home'
        Tap $tabs.Settings $navY
        Save-Page $lang 'settings'
        Tap 0.50 0.203          # Execution & access
        Save-Page $lang 'capabilities'
        Invoke-Shell 'input keyevent 4'; Start-Sleep -Milliseconds 1500
        Tap 0.50 0.290          # Agent connection
        Save-Page $lang 'agents'
        Invoke-Shell 'input keyevent 4'; Start-Sleep -Milliseconds 1500
    }
} finally {
    Invoke-Shell 'am broadcast -a com.android.systemui.demo -e command exit'
    Invoke-Shell "cmd locale set-app-locales $Package --locales ''"
    if ($previousNight) { Invoke-Shell "cmd uimode night $previousNight" }
}
