# Mechano Download Manager (MDM)

IDM-style download manager for Windows. Owner: Eslam (talks in Egyptian Arabic; answer in Arabic, keep replies short).

## Layout
- `Mechano DM.exe` — the Windows program (source `desktop/MechanoDM.cs`, C# 5 / .NET Framework 4, WinForms + WebView2 from `lib/`).
  Runs the engine (`node bin/mdm.js serve`, child process in a kill-on-close job object), tray icon, main window (WebView2 → http://127.0.0.1:9614/),
  floating "New download" window (quality + save folder), "Download complete" popup. Log: `data/host.log`. Rebuild: `desktop\build-exe.cmd` (stop the app first).
- Engine (Node, no npm deps): `src/server.js` (local API, token + Host checks, `data/server.log`), `src/manager.js` (queue, confirm step, categories,
  playlist entries API), `src/segmented.js` (multi-connection), `src/hls.js`, `src/ytdlp.js` (yt-dlp bridge, `--encoding utf-8`), `src/playlist.js`
  (playlist video-by-video), `src/scheduler.js` + `src/power.js` (scheduler, after-finish action), `src/updater.js` (yt-dlp auto-update, 5 days).
- UI: single file `ui/index.html` (themes Auto/Light/Dark, frame glow, playlist "Videos" panel). Extension (Chrome MV3): `extension/`.
- Data: `data/` (config.json has the private token — never share/copy). Downloads: `%USERPROFILE%\Downloads\M.DM\<Category>`.

## Commands
- Tests: `node --test test/` (28 tests, all offline).
- Portable build: `powershell -ExecutionPolicy Bypass -File build-portable.ps1` → `dist\Mechano DM.zip` (bundles node, yt-dlp, ffmpeg, lib).
- Installer: `powershell -ExecutionPolicy Bypass -File build-setup.ps1 [-Rebuild]` → `dist\Mechano DM Setup.exe` (~90 MB, source `desktop/Setup.cs`,
  LZX cab via makecab + setupapi; per-user install to %LOCALAPPDATA%\Programs\Mechano DM, Uninstall.exe, `/silent /dir= /nolaunch /nodesktop` for tests).
- Restart the app after engine/UI changes: stop process `Mechano DM`, start `Mechano DM.exe` (UI-only changes: F5 in the window).
- Shortcuts: `desktop\install-shortcut.ps1`. Icons: `node assets/build-icon.js <ffmpeg>` from `assets/logo-source.png`.

## Rules
- No DRM bypass. Don't download files/tools without asking. PowerShell 5.1: keep .ps1 files ASCII (Arabic text goes in separate UTF-8 files).
- csc is C# 5: no `$""`, `?.`, `nameof`, `out var`.
