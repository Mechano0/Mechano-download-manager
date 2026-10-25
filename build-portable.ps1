# Builds a portable copy of Mechano Download Manager: one folder (and a .zip of it) that runs on
# any Windows 10/11 PC without installing anything. It includes Node.js, yt-dlp and ffmpeg.
# Your personal data (data\: history, private key, cookies, logs) is NOT included.
#
#   powershell -ExecutionPolicy Bypass -File build-portable.ps1
#
# Output: dist\Mechano DM\  and  dist\Mechano DM.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'Mechano DM'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

# 1) The program itself (no data\, no tests, no build output)
foreach ($d in 'src', 'ui', 'assets', 'desktop', 'extension', 'docs', 'lib') {
  Copy-Item (Join-Path $root $d) (Join-Path $out $d) -Recurse
}
New-Item -ItemType Directory -Force (Join-Path $out 'bin') | Out-Null
Copy-Item (Join-Path $root 'bin\mdm.js') (Join-Path $out 'bin\mdm.js')
foreach ($f in 'Mechano DM.exe', 'package.json', 'README.md') { Copy-Item (Join-Path $root $f) (Join-Path $out $f) }
Remove-Item (Join-Path $out 'assets\logo-source.png') -ErrorAction SilentlyContinue

# 2) Runtimes and tools, each with its license
$lic = Join-Path $out 'licenses'
New-Item -ItemType Directory -Force $lic, (Join-Path $out 'runtime') | Out-Null

$node = (Get-Command node).Source
Copy-Item $node (Join-Path $out 'runtime\node.exe')
$nodeLic = Join-Path (Split-Path $node) 'LICENSE'
if (Test-Path $nodeLic) { Copy-Item $nodeLic (Join-Path $lic 'Node.js-LICENSE.txt') }

$ytdlp = (Get-Command yt-dlp).Source
Copy-Item $ytdlp (Join-Path $out 'bin\yt-dlp.exe')
Set-Content -Encoding utf8 (Join-Path $lic 'yt-dlp-LICENSE.txt') @'
yt-dlp is released into the public domain under The Unlicense.
Source code and full license: https://github.com/yt-dlp/yt-dlp
'@

$ffmpeg = (Get-Command ffmpeg).Source
Copy-Item $ffmpeg (Join-Path $out 'bin\ffmpeg.exe')
$ffLic = Join-Path (Split-Path (Split-Path $ffmpeg)) 'LICENSE.txt'
if (Test-Path $ffLic) { Copy-Item $ffLic (Join-Path $lic 'FFmpeg-LICENSE.txt') }
Add-Content -Encoding utf8 (Join-Path $lic 'FFmpeg-LICENSE.txt') @"

---
This copy of FFmpeg ($(& $ffmpeg -version | Select-Object -First 1)) is the GPL build published by
the yt-dlp project. Its complete source code is available at:
https://github.com/yt-dlp/FFmpeg-Builds  and  https://ffmpeg.org/download.html
"@

# 3) First-run helpers for the new PC
Set-Content -Encoding ascii (Join-Path $out 'Create desktop shortcut.cmd') @'
@echo off
rem Puts a "Mechano Download Manager" icon on the desktop and in the Start menu for THIS folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\install-shortcut.ps1"
echo.
echo Done. You can now start Mechano DM from the desktop icon.
pause
'@

Copy-Item (Join-Path $root 'desktop\portable-readme.txt') (Join-Path $out 'Read me first.txt')

# 4) Zip it
$zip = Join-Path $dist 'Mechano DM.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal

$size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output ("Portable folder: {0}  ({1:N0} MB)" -f $out, ($size / 1MB))
Write-Output ("Zip:             {0}  ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
