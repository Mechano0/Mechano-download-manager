# Mechano Download Manager (MDM)

IDM-style download manager for Windows. Owner: Eslam (talks in Egyptian Arabic; answer in Arabic, keep replies short).

## Layout
- `Mechano DM.exe` — the Windows program (source `desktop/MechanoDM.cs`, C# 5 / .NET Framework 4, WinForms + WebView2 from `lib/`).
  Runs the engine (`node bin/mdm.js serve`, child process in a kill-on-close job object), tray icon, main window (WebView2 → http://127.0.0.1:9614/),
  floating "New download" window (quality + save folder), "Download complete" popup. Log: `data/host.log`. Rebuild: `desktop\build-exe.cmd` (stop the app first).
- Engine (Node, no npm deps): `src/server.js` (local API, token + Host checks, `data/server.log`), `src/manager.js` (queue, confirm step, categories,
  playlist entries API), `src/segmented.js` (multi-connection), `src/hls.js`, `src/ytdlp.js` (yt-dlp bridge, `--encoding utf-8`), `src/playlist.js`
  (playlist video-by-video), `src/scheduler.js` + `src/power.js` (scheduler, after-finish action), `src/updater.js` (yt-dlp auto-update, 5 days;
  folder build `bin\yt-dlp\` = official yt-dlp_win.zip, gitignored, updated by download + SHA2-256SUMS; one-file exe starts 10+ s slower).
  Facebook sd/hd: `probeMp4` reads their size from the first 256 KB; quality values `360:sd` pick them by id. The extension prefetches qualities after 2 s on a video.
  New (v1.1): `src/media.js` (fast video: yt-dlp finds URLs, our engine downloads, ffmpeg joins; falls back to plain yt-dlp), `src/torrent.js`
  (aria2c `bin\aria2c.exe` over JSON-RPC, random port+secret), `src/grabber.js` (Site Grabber), `src/preview.js` (play while downloading),
  `src/selfupdate.js` (signed version.json from GitHub releases; Ed25519 public key inside; private key `%USERPROFILE%\.mechano-dm\update-signing-key.pem`,
  never in the repo; Mechano DM.exe runs the verified Setup `/silent /dir=`). Clipboard monitor: C# `ClipboardWatcher` → `/api/clipboard`.
- Taskbar icon: `desktop/ShellProps.cs` (compiled into both exes) stamps AppUserModelID `Mechano.DownloadManager` on shortcuts (Setup, and
  the app fixes old ones at start) and on windows (relaunch icon/name), otherwise Windows shows a blank taskbar icon.
- Floating window: ⧉ Float on a running job → page posts `{type:'float',id}` → C# `FloatForm` (TopMost, tool window, bottom-right)
  shows `ui/float.html?id=` (drag/close/main messages). In a browser it uses Document Picture-in-Picture with an iframe.
- Extras (v1.2): auto-retry of network errors (`autoRetry`, delays 10/30/60 s, `job.retryAt`, `isRetriable`); Defender scan after download
  (`src/scan.js`, MpCmdRun `-Scan -ScanType 3`, `scanDownloads` risky/all/off, `job.scan`, env `MDM_NO_SCAN=1` in tests); same-name choice
  (`ifExists`, dialog asks via `/api/jobs/:id/exists`, confirm `onExists: replace` → overwrite); "Many links" batch (POST `/api/jobs` array, bad
  links skipped); statistics (`src/stats.js` → `data/stats.json`, `/api/stats`, History card); 🐢 in float.html toggles `speedLimitKBps` ↔
  `quickLimitKBps`; C#: done sound (`completeSound`), balloon on Defender threat, balloon when the complete window is off, `DropForm` drop box
  (`dropTarget`, tray toggle, position in `data/drop-box.txt`). Code signing: `docs/CODE-SIGNING.md`, `build-setup.ps1 -SignThumbprint`.
- UI: `ui/index.html` (mail-style side bar with 3 folders: Downloads = link bar + list, History = done/error jobs with search, range,
  Open/Folder/Retry, `finishedAt`; Settings = settings form; ⚙ opens Settings; themes Auto/Light/Dark, frame glow, playlist "Videos" panel, Site Grabber, app-update bar), `ui/dialog.html`
  ("Download File Info" window: own WebView2 window `WebConfirmForm` in the app, iframe in the page; old WinForms `ConfirmForm` = fallback),
  `ui/i18n.js` (Arabic + RTL: exact-string dictionary + regex patterns + MutationObserver; mark names/paths `translate="no"`).
  Server injects `__MDM_TOKEN__` and `__MDM_LANG__`. Extension (MV3, Chrome/Edge): `extension/`; Firefox: `node tools/build-firefox.js`.
- Unfinished pieces (.mdmpart, HLS segments, yt-dlp .part/-Frag via `-P temp:`) live in `data\work\<job id>`, never in the save folder;
  removing an unfinished job always deletes them (manager.removePartials), finished jobs clean it, startup prunes orphans.
- Data: `data/` (config.json has the private token — never share/copy). Downloads: `%USERPROFILE%\Downloads\M.DM\<Category>`.

## Commands
- Tests: `node --test test/` (44 tests, all offline).
- Release: bump `package.json` version → `build-setup.ps1 -Rebuild` → `node tools/sign-release.js --notes "..."` → upload `Mechano.DM.Setup.exe`,
  `Mechano.DM.zip`, `version.json` to a GitHub release `v<version>`. Small ffmpeg: artifact `ffmpeg-win64` of `.github/workflows/ffmpeg.yml` → `tools\ffmpeg\out\`.
- Execution policy is Bypass for CurrentUser: run scripts as `powershell -File x.ps1` (no `-ExecutionPolicy` flag).
- Portable build: `powershell -ExecutionPolicy Bypass -File build-portable.ps1` → `dist\Mechano DM.zip` (bundles node, yt-dlp, ffmpeg, lib).
- Installer: `powershell -ExecutionPolicy Bypass -File build-setup.ps1 [-Rebuild]` → `dist\Mechano DM Setup.exe` (~55 MB, source `desktop/Setup.cs`,
  LZX cab via makecab + setupapi; per-user install to %LOCALAPPDATA%\Programs\Mechano DM, Uninstall.exe, `/silent /dir= /nolaunch /nodesktop` for tests).
- Restart the app after engine/UI changes: stop process `Mechano DM`, start `Mechano DM.exe` (UI-only changes: F5 in the window).
- Shortcuts: `desktop\install-shortcut.ps1`. Icons: `node assets/build-icon.js <ffmpeg>` from `assets/logo-source.png`.

## Rules
- No DRM bypass. Don't download files/tools without asking. PowerShell 5.1: keep .ps1 files ASCII (Arabic text goes in separate UTF-8 files).
- csc is C# 5: no `$""`, `?.`, `nameof`, `out var`.
