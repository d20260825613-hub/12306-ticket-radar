# Build 12306 Ticket Radar as a standalone Windows executable and install it
# as a self-contained folder.
#
# ASCII-ONLY SOURCE. Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI, so any
# non-ASCII byte here (including full-width quotes inside comments) can corrupt
# command parsing. Chinese text is produced via [char]0x.... code points instead.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build_exe.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build_exe.ps1 -InstallDir D:\somewhere
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build_exe.ps1 -SkipShortcut

param(
  [string]$InstallDir = '',
  [switch]$SkipShortcut
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = [Environment]::GetFolderPath('Desktop')
}

# App folder / exe name from code points: U+4F59 U+7968 U+96F7 U+8FBE
$appName = -join @([char]0x4F59, [char]0x7968, [char]0x96F7, [char]0x8FBE)
$appDir = Join-Path $InstallDir $appName
$exeName = $appName + '.exe'

Write-Output ''
Write-Output '=== 12306 Ticket Radar - build ==='
Write-Output ('root    : ' + $root)
Write-Output ('install : ' + $appDir)
Write-Output ''

# ---- 1. locate csc.exe (.NET Framework compiler, ships with Windows) ----
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  throw 'csc.exe not found - .NET Framework 4.x is required to build the launcher.'
}
Write-Output ('compiler: ' + $csc)

# ---- 2. icons ----
$iconApp = Join-Path $root 'assets\app.ico'
$iconLauncher = Join-Path $root 'assets\launcher.ico'
if (-not (Test-Path $iconApp)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\make_icon.ps1') $root | Out-Null
}
if (-not (Test-Path $iconLauncher)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\make_launcher_icon.ps1') $root | Out-Null
}
if (-not (Test-Path $iconApp)) { throw 'failed to generate assets\app.ico' }
if (-not (Test-Path $iconLauncher)) { throw 'failed to generate assets\launcher.ico' }

# ---- 3. compile launcher ----
$src = Join-Path $root 'tools\Launcher.cs'
$outExe = Join-Path $root 'build\launcher.exe'
New-Item -ItemType Directory -Force -Path (Split-Path $outExe) | Out-Null

& $csc /nologo /target:exe /platform:anycpu /optimize+ "/win32icon:$iconLauncher" "/out:$outExe" $src

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outExe)) {
  throw "csc failed with exit code $LASTEXITCODE"
}
Write-Output ('compiled: ' + [math]::Round((Get-Item $outExe).Length / 1KB, 1) + ' KB')

# ---- 4. stage the self-contained folder ----
#
# IMPORTANT: update IN PLACE. Never delete the whole install folder first.
# A running instance resolves static files from disk on every request, so
# removing the folder makes all its pages 404 while its API keeps answering
# from memory. Clearing only the sub-folder contents keeps a live instance
# working (it may briefly read a mix of old and new files, which is fine).
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# PRESERVE USER DATA.
# data/config.json holds the user's third-party id/key and WeChat token, and
# data/state.json holds their watch history. Rebuilding must never wipe them --
# an earlier version deleted both as "build artefacts" and destroyed a user's
# credentials. Back them up, then put them back after staging.
$preserve = @()
foreach ($f in @('config.json', 'state.json')) {
  $p = Join-Path (Join-Path $appDir 'data') $f
  if (Test-Path -LiteralPath $p) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('radar-keep-' + $f)
    Copy-Item -LiteralPath $p -Destination $tmp -Force
    $preserve += @{ file = $f; tmp = $tmp }
  }
}
if ($preserve.Count -gt 0) {
  Write-Output ('preserving user data: ' + (($preserve | ForEach-Object { $_.file }) -join ', '))
}

$subDirs = @('src', 'web', 'tools', 'data', 'assets')
foreach ($d in $subDirs) {
  $target = Join-Path $appDir $d
  if (Test-Path $target) {
    # remove contents only, keep the directory itself
    Get-ChildItem -LiteralPath $target -Force | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  } else {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
  }
}

foreach ($d in $subDirs) {
  $from = Join-Path $root $d
  if (Test-Path $from) {
    # copy contents (not the folder) so we never create data\data nesting
    Copy-Item -Path (Join-Path $from '*') -Destination (Join-Path $appDir $d) -Recurse -Force
  }
}
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $appDir -Force

# Restore preserved user data AFTER copying.
# Order matters: the project may ship its own (empty) data\config.json, and
# copying it last would overwrite the user's real settings -- which is exactly
# what happened the first time this was written.
foreach ($k in $preserve) {
  $dst = Join-Path (Join-Path $appDir 'data') $k.file
  Copy-Item -LiteralPath $k.tmp -Destination $dst -Force
  Remove-Item -LiteralPath $k.tmp -Force -ErrorAction SilentlyContinue
  Write-Output ('restored: data\' + $k.file)
}

# Strip artefacts that must not ship.
# NOTE: config.json / state.json are NOT here on purpose -- they are the
# user's own data and are preserved above.
$junk = @(
  'web\.backup-v1', 'data\edge-profile',
  'data\icon-preview.png', 'data\launcher-icon-preview.png', 'data\shot-radar.png',
  'data\port.txt'
)
foreach ($j in $junk) {
  Remove-Item -LiteralPath (Join-Path $appDir $j) -Recurse -Force -ErrorAction SilentlyContinue
}

# Stage the launcher exe.
#
# A running instance locks its own exe, so Copy-Item would throw IOException.
# That must not fail the whole build: web/ and src/ are already updated and a
# page refresh picks them up. So warn and continue instead.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less .ps1
# as ANSI, and non-ASCII bytes here corrupt parsing.
try {
  Copy-Item -LiteralPath $outExe -Destination (Join-Path $appDir $exeName) -Force -ErrorAction Stop
} catch {
  Write-Output ''
  Write-Output '  [i] launcher exe is locked (program is running) - skipped replacing it.'
  Write-Output '      web/ and src/ were updated; refresh the page to pick them up.'
  Write-Output '      If this change touched server code, close the program and rebuild.'
  Write-Output ''
}
try {
  Copy-Item -LiteralPath $outExe -Destination (Join-Path $root ('build\' + $exeName)) -Force -ErrorAction Stop
} catch {
  Write-Output '  [i] build\ copy also locked - skipped.'
}

# ---- 5. shortcut ----
if (-not $SkipShortcut) {
  $lnk = Join-Path $InstallDir ($appName + '.lnk')
  $sh = New-Object -ComObject WScript.Shell
  $sc = $sh.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $appDir $exeName
  $sc.WorkingDirectory = $appDir
  $sc.IconLocation = (Join-Path $appDir $exeName) + ',0'
  $sc.Description = '12306 ticket radar - read-only query and alerts; book via official channels'
  $sc.Save()
  Write-Output ('shortcut: ' + $lnk)
}

# remove the legacy bat-based shortcut when installing to the Desktop
$legacy = Join-Path $InstallDir ('12306 ' + $appName + '.lnk')
if (Test-Path -LiteralPath $legacy) {
  Remove-Item -LiteralPath $legacy -Force
  Write-Output 'removed legacy shortcut (12306 <name>.lnk)'
}

# ---- 6. report ----
Write-Output ''
Write-Output '=== installed ==='
Write-Output ('folder  : ' + $appDir)
Write-Output ('launcher: ' + $exeName)
$total = (Get-ChildItem -LiteralPath $appDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$files = (Get-ChildItem -LiteralPath $appDir -Recurse -File | Measure-Object).Count
Write-Output ('size    : ' + [math]::Round($total / 1KB, 1) + ' KB in ' + $files + ' files (excl. Node.js)')
Write-Output ''

# sanity: no nested duplication from the in-place copy
foreach ($d in $subDirs) {
  if (Test-Path (Join-Path (Join-Path $appDir $d) $d)) {
    throw "nested folder detected: $d\$d - the in-place copy went wrong"
  }
}

Get-ChildItem -LiteralPath $appDir | Select-Object Mode, Name | Format-Table -AutoSize
