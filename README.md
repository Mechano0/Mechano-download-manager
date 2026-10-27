# Mechano Download Manager (MDM)

An IDM-style download manager for Windows: multi-connection downloads, resume, video downloads from
YouTube, Facebook, Instagram, TikTok and more, a scheduler and a Chrome / Edge button on videos.

<p align="center"><img src="assets/logo-256.png" width="128" alt="Mechano DM logo"></p>

## Download

**[⬇ Mechano DM Setup.exe](../../releases/latest)** (one file, about 55 MB). Everything is inside: Node.js, yt-dlp and ffmpeg.

1. Double-click **Mechano DM Setup.exe**, then click **Install**. It needs no admin rights and no internet to install.
2. Click **Finish**, and Mechano DM opens.
3. For the Download button on videos, click **Add the Download button to Chrome / Edge** on the last screen and follow the 3 steps.

If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. The app isn't signed with a paid certificate.
To remove it: **Settings → Apps → Mechano Download Manager → Uninstall**. Your downloaded files stay where they are.

> **بالعربي:** حمّل `Mechano DM Setup.exe` من [Releases](../../releases/latest)، دبل كليك ← **Install** ← **Finish**، والبرنامج يفتح على طول.
> مش محتاج تحمّل أي أداة تانية، ولا محتاج صلاحيات أدمن.

## Features

- **Multi-connection downloads** with IDM-style *dynamic segmentation*: each free connection splits the largest remaining part (up to 32 connections).
- **Pause / resume**, even after closing the app or restarting the PC.
- **YouTube, Facebook, Instagram, TikTok, X, Vimeo, Reddit and more** through yt-dlp, with a quality choice. Saved as MP4 (H.264 + AAC), which plays everywhere.
- **Whole playlists**: a "Videos" panel shows the current video, and you can skip or re-order videos.
- **Fast video downloads**: yt-dlp finds the video, then MDM's own multi-connection engine downloads it (picture and sound in parallel) and ffmpeg joins them without re-encoding.
- **"Download File Info" window** for every new download: category, quality, *Save As* (full path), *Remember this path for the category*, description, connections, file type and size, *Start* / *Download later* / *Cancel*.
- **Clipboard monitor**: copy a download link anywhere and the window opens (on/off in Settings or the tray menu).
- **Torrents**: magnet links and .torrent links (aria2), with pause / resume.
- **Site Grabber**: lists the files linked from a page (and its pages on the same site); tick and download.
- **Play while downloading**: opens what is downloaded so far in your video player.
- **Arabic interface** (right-to-left) or English, from Settings.
- **Optional app updates**, signed: Settings → App updates (Tell me / Install automatically / Off).
- **"Download complete"** popup with *Open* / *Open folder*.
- **Scheduler and queue** like IDM: start time, days of the week, "N files at the same time", re-ordering. After it finishes the app can sleep, hibernate, restart or shut down the PC.
- **HLS streams** (`.m3u8`) with AES-128, plus a speed limit and category folders (`Downloads\M.DM\Video`, `Music`, …).
- **yt-dlp updates itself** every 5 days, or press ⟳ (official release, checked against its SHA-256).
- **Light / dark themes**, tray icon, start with Windows, and its own taskbar icon.
- **Browser extension** (Chrome / Edge, and Firefox): a Download button on videos, download takeover, and right-click "Download with Mechano DM".

## Build from source

Needs Windows 10/11 and Node.js 20+. The engine has no npm dependencies.

```bash
node --test test/
```

```bash
desktop\build-exe.cmd
```

`build-exe.cmd` builds `Mechano DM.exe` (the Windows window) with the C# compiler that comes with Windows.
Unzip yt-dlp's official `yt-dlp_win.zip` into `bin\yt-dlp\` (it starts much faster than the one-file `yt-dlp.exe`), put `ffmpeg.exe` and `aria2c.exe` in `bin\`, then run `Mechano DM.exe`.
The small LGPL ffmpeg the Setup ships is built by `.github/workflows/ffmpeg.yml` (`tools/ffmpeg/build.sh`); put its output in `tools\ffmpeg\out\`.

Firefox extension: `node tools/build-firefox.js` → `dist\mechano-dm-firefox.xpi` (Firefox needs it signed by addons.mozilla.org; for testing load `dist\firefox\manifest.json` in `about:debugging`).

Release updates: after building the Setup, `node tools/sign-release.js --notes "…"` writes `dist\version.json` signed with the release key (kept outside the repository); upload it with the Setup.

To build the one-file installer (`dist\Mechano DM Setup.exe`) and the portable zip:

```bash
powershell -ExecutionPolicy Bypass -File build-setup.ps1 -Rebuild
```

### Project layout

| Path | What it is |
|---|---|
| `desktop/MechanoDM.cs` | The Windows app: tray, main window (WebView2), floating windows. It runs the engine. |
| `desktop/Setup.cs` | The installer / uninstaller (LZX cabinet unpacked with Windows' setupapi). |
| `src/` | Engine (Node.js): `segmented.js` multi-connection, `media.js` fast video path, `hls.js`, `ytdlp.js`, `playlist.js`, `torrent.js`, `grabber.js`, `preview.js`, `manager.js` queue, `scheduler.js`, `updater.js` (yt-dlp), `selfupdate.js` (signed app updates), `server.js` local API. |
| `ui/` | The interface: `index.html` main window, `dialog.html` Download File Info window, `i18n.js` Arabic. |
| `extension/` | Browser extension (Manifest V3; `tools/build-firefox.js` makes the Firefox package). |
| `test/` | Offline tests (`node --test test/`). |

### Security

The local API listens on `127.0.0.1` only. Every request needs a private token that each PC creates on first run. A Host-header check blocks DNS rebinding, and only the browser extension can pair.
Cookies a download needs are kept only for that download, then deleted.

## Legal

- Download only content you have the right to save: your own files, public-domain or Creative Commons media, or anything the site's terms allow.
- **DRM-protected media** (Netflix, Disney+, Spotify, Widevine/FairPlay, SAMPLE-AES) is detected and refused. MDM does not bypass DRM.
- Code: [MIT License](LICENSE). The Setup bundles Node.js (MIT), yt-dlp (Unlicense), FFmpeg + LAME (LGPL, own small build) and aria2 (GPL-2.0, unmodified), each with its license.
