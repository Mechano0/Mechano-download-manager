# Mechano Download Manager (MDM)

IDM-style download manager for Windows. Owner: Eslam (talks in Egyptian Arabic; answer in Arabic, keep replies short).
Eslam's working rule: when he sends a message, first reply saying what you will do, then start.

History of the old chats (lost with the 2026-11-01 Windows reinstall), read it first:
@CHAT_SUMMARY.md

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
  `src/selfupdate.js` (signed version.json from GitHub releases; Ed25519 public key inside; private key `.private\update-signing-key.pem`
  in THIS folder, gitignored, never in the repo; Mechano DM.exe runs the verified Setup `/silent /dir=`). Key 2 since 2026-11-01: key 1 was lost
  in a Windows reinstall (it lived in %USERPROFILE%), so copies up to v1.1.0 reject newer releases and must install v1.1.1 by hand once. Clipboard monitor: C# `ClipboardWatcher` → `/api/clipboard`.
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
- Fast start (2026-11-02): the details window probe is kept on `job.probe` (3 min) and passed to SegmentedDownload as `o.info`;
  without it, the probe runs with `keepOpen` and its answer is the first segment (`firstRes`), so Start costs no extra request.
  yt-dlp `-J` answers are cached 10 min per link (`infoCache` in ytdlp.js); `resolve()` reuses them with `--load-info-json`
  (`noCache` after expired links). C# waits on `/api/wait-confirm` (long poll) so the dialog opens at once; `WebConfirmForm.Prewarm()`.
- Unfinished pieces (.mdmpart, HLS segments, yt-dlp .part/-Frag via `-P temp:`) live in `data\work\<job id>`, never in the save folder;
  removing an unfinished job always deletes them (manager.removePartials), finished jobs clean it, startup prunes orphans.
- Data: `data/` (config.json has the private token — never share/copy). Downloads: `%USERPROFILE%\Downloads\M.DM\<Category>`.

## Commands
- Tests: `tools\node\node.exe --test test/` with env `MDM_NO_SCAN=1` (47 tests, all offline).
- Release: bump `package.json` version → `build-setup.ps1 -Rebuild` → `node tools/sign-release.js --notes "..."` → upload `Mechano.DM.Setup.exe`,
  `Mechano.DM.zip`, `version.json` to a GitHub release `v<version>`. Small ffmpeg: artifact `ffmpeg-win64` of `.github/workflows/ffmpeg.yml` → `tools\ffmpeg\out\`.
- Execution policy is Bypass for CurrentUser: run scripts as `powershell -File x.ps1` (no `-ExecutionPolicy` flag).
- Portable build: `powershell -ExecutionPolicy Bypass -File build-portable.ps1` → `dist\Mechano DM.zip` (bundles node, yt-dlp, ffmpeg, lib).
- Installer: `powershell -ExecutionPolicy Bypass -File build-setup.ps1 [-Rebuild]` → `dist\Mechano DM Setup.exe` (~55 MB, source `desktop/Setup.cs`,
  LZX cab via makecab + setupapi; per-user install to %LOCALAPPDATA%\Programs\Mechano DM, Uninstall.exe, `/silent /dir= /nolaunch /nodesktop /nostartup` for tests).
  "Start with Windows" (Startup\Mechano Download Manager.lnk, `-Background` = tray only): ON by default for a NEW install (checkbox in
  the Setup window); an update (folder already installed, incl. self-update) keeps the user's choice; `/nostartup` leaves it untouched.
  Test installs share the real shortcuts: always pass `/nostartup`, use a short `/dir=` (long paths fail), and after running a test
  `Uninstall.exe` re-run the real Setup `/silent /nolaunch` (uninstall removes the Start-menu, desktop, Startup links and Apps entry).
- Restart the app after engine/UI changes: stop process `Mechano DM`, start `Mechano DM.exe` (UI-only changes: F5 in the window).
- Shortcuts: `desktop\install-shortcut.ps1`. Icons: `node assets/build-icon.js <ffmpeg>` from `assets/logo-source.png`.

## Rules
- **Everything the project needs stays inside this folder** (Eslam's rule): keys, notes, tools, build inputs. Never store project files in
  %USERPROFILE%, %APPDATA% or C:\ (the PC was reinstalled on 2026-11-01 and the old signing key was lost that way). Private files go in
  `.private\` (gitignored). Location: `D:\cloude project\my portfolio data\my-download-manager` (old copy `D:\cloude project\Mechano Download Manager` is outdated, v1.0.0).
- Node.js is not installed system-wide; builds use `tools\node\node.exe` (v26.12.0, gitignored). v1.1.1 (new key) built + signed 2026-11-01,
  copies in `D:\cloude project\Mechano Download Manager\02-final product\release\`. Source pushed to `main` (8140e4a) and
  GitHub release `v1.1.1` published 2026-11-01 (Setup.exe, zip, version.json; live feed checked, signature OK).
  Every release must also carry the browser extension: `Mechano.DM.Extension.zip` (zip of `dist\Mechano DM Extension\`:
  Chrome folder + Mozilla-signed xpi + install steps; build it with .NET ZipArchive, forward-slash paths) and
  `mechano-dm-firefox.xpi` = `dist\mechano-dm-firefox-signed.xpi` (NOT the unsigned one). Both added to v1.1.1 on 2026-11-02.
  Extension is now 1.3.3 (POST/form downloads: it keeps the form body + content-type and sends them as `post` {body base64, type};
  the engine re-sends one POST, single connection, no probe; job.post dropped when finished), not released: the next release needs a new Mozilla-signed xpi
  (the signed 1.3.2 xpi is outdated) and a rebuilt Extension.zip.
- Git 2.56 is installed. The repo folder is owned by the old Windows user, so run git as `git -c safe.directory=* ...`
  (or Eslam adds a global safe.directory). GitHub CLI: `C:\Program Files\GitHub CLI\gh.exe` (logged in as Mechano0).
  Releases: `gh release create v<ver> -R Mechano0/Mechano-download-manager` with assets named with dots (copy them first).
  GitHub repo `Mechano0/Mechano-download-manager` (releases v1.0.0 ... v1.1.1 published; old lowercase URL redirects).
- No DRM bypass. Don't download files/tools without asking. PowerShell 5.1: keep .ps1 files ASCII (Arabic text goes in separate UTF-8 files).
- csc is C# 5: no `$""`, `?.`, `nameof`, `out var`.
