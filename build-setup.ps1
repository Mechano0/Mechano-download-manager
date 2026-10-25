# Builds "dist\Mechano DM Setup.exe": ONE file that installs Mechano Download Manager
# (with Node.js, yt-dlp and ffmpeg inside) and opens it. Nothing is downloaded on the new PC.
#
#   powershell -ExecutionPolicy Bypass -File build-setup.ps1            (uses dist\Mechano DM from build-portable.ps1)
#   powershell -ExecutionPolicy Bypass -File build-setup.ps1 -Rebuild   (runs build-portable.ps1 first)
#
# Compression: Windows cabinet, LZX with the largest window (makecab, built into Windows). It takes a few minutes.
# Your personal data (data\) is never included.
param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'
$app = Join-Path $dist 'Mechano DM'
if ($Rebuild -or -not (Test-Path (Join-Path $app 'Mechano DM.exe'))) { & (Join-Path $root 'build-portable.ps1') }

$work = Join-Path $dist 'setup-build'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$src = Join-Path $root 'desktop\Setup.cs'
$common = @('/nologo', '/codepage:65001', '/target:winexe', '/optimize+', '/platform:x64',
  ('/win32icon:' + (Join-Path $root 'assets\mdm.ico')), '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')

# 1) Uninstall.exe = the same program without the payload
& $csc @common ('/out:' + (Join-Path $work 'Uninstall.exe')) $src
if ($LASTEXITCODE -ne 0) { throw 'csc failed (Uninstall.exe)' }

# 2) Pack the program into a cabinet (things only needed for building or for the portable zip are left out)
$skipDirs = @('desktop\', 'docs\')
$skipFiles = @('Create desktop shortcut.cmd', 'Read me first.txt')
$files = @()
foreach ($f in Get-ChildItem $app -Recurse -File) {
  $rel = $f.FullName.Substring($app.Length + 1)
  $skip = $skipFiles -contains $rel
  foreach ($d in $skipDirs) { if ($rel.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { $skip = $true } }
  if (-not $skip) { $files += New-Object PSObject -Property @{ Path = $f.FullName; Rel = $rel; Size = $f.Length } }
}
$un = Get-Item (Join-Path $work 'Uninstall.exe')
$files += New-Object PSObject -Property @{ Path = $un.FullName; Rel = 'Uninstall.exe'; Size = $un.Length }

$ddf = @('.OPTION EXPLICIT', '.Set CabinetNameTemplate=payload.cab', ('.Set DiskDirectoryTemplate="' + $work + '"'),
  '.Set Cabinet=on', '.Set Compress=on', '.Set CompressionType=LZX', '.Set CompressionMemory=21',
  '.Set MaxDiskSize=0', '.Set FolderSizeThreshold=0', '.Set UniqueFiles=on', '.Set RptFileName=nul', '.Set InfFileName=nul')
foreach ($f in $files) { $ddf += ('"' + $f.Path + '" "' + $f.Rel + '"') }
[IO.File]::WriteAllLines((Join-Path $work 'payload.ddf'), $ddf)
Write-Output ('Packing {0} files (LZX, takes a few minutes)...' -f $files.Count)
& makecab.exe /F (Join-Path $work 'payload.ddf') | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $work 'payload.cab'))) { throw 'makecab failed' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$bytes = ($files | Measure-Object Size -Sum).Sum
[IO.File]::WriteAllLines((Join-Path $work 'info.txt'), @("version=$version", "bytes=$bytes"))

# 3) Setup.exe = the same program with the cabinet, version info and logo inside
$setup = Join-Path $dist 'Mechano DM Setup.exe'
& $csc @common ('/resource:' + (Join-Path $work 'payload.cab') + ',payload.cab') ('/resource:' + (Join-Path $work 'info.txt') + ',info.txt') `
  ('/resource:' + (Join-Path $root 'assets\logo-64.png') + ',logo.png') ('/out:' + $setup) $src
if ($LASTEXITCODE -ne 0) { throw 'csc failed (Setup.exe)' }

Remove-Item $work -Recurse -Force
Write-Output ('Setup: {0}  ({1:N1} MB, installs {2:N0} MB)' -f $setup, ((Get-Item $setup).Length / 1MB), ($bytes / 1MB))
