# Creates "Mechano Download Manager" shortcuts on the Desktop and in the Start menu,
# pointing at Mechano DM.exe in THIS folder (run it again after moving the folder).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'Mechano DM.exe'
if (-not (Test-Path $exe)) { Write-Output "Mechano DM.exe not found in $root"; exit 1 }
$sh = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mechano Download Manager.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Mechano Download Manager.lnk')
)
foreach ($t in $targets) {
  $l = $sh.CreateShortcut($t)
  $l.TargetPath = $exe
  $l.Arguments = ''
  $l.IconLocation = "$exe,0"
  $l.WorkingDirectory = $root
  $l.Description = 'Mechano Download Manager'
  $l.Save()
  Write-Output "Created $t"
}
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Mechano Download Manager.lnk'
if (Test-Path $startup) {
  $l = $sh.CreateShortcut($startup)
  $l.TargetPath = $exe; $l.Arguments = '-Background'; $l.IconLocation = "$exe,0"; $l.WorkingDirectory = $root; $l.Save()
  Write-Output "Updated $startup"
}
Start-Process -FilePath "$env:WINDIR\System32\ie4uinit.exe" -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue
