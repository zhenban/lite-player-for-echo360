**English** | [简体中文](README.zh-CN.md)

# Lite Player for Echo360

[![CI](https://github.com/zhenban/lite-player-for-echo360/actions/workflows/ci.yml/badge.svg)](https://github.com/zhenban/lite-player-for-echo360/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhenban/lite-player-for-echo360)](https://github.com/zhenban/lite-player-for-echo360/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

**A userscript that plays Echo360 lecture recordings in a light, fast player: far less CPU, both views side by side, slide chapters, a PDF that follows the lecture, captions, notes and more.**

![The player: screen and camera side by side, slide chapters in the side panel](docs/screenshot.jpg)

> **Unofficial.** This project is not affiliated with, endorsed by or supported by Echo360 or UNSW. "Echo360" is used only to say which site the script works with.

The stock player keeps one CPU core busy for the whole lecture (loud fans, drained battery). Lite Player for Echo360 plays the same streams with the browser's own video player, at close to the cost of playing a plain video file. Tested on `echo360.net.au` (Australia); if a page is not recognised, the original player is used automatically.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
   In Chrome or Edge, open the manager's details at `chrome://extensions` and turn on **Allow user scripts** (on older versions, turn on Developer mode).
2. Install the script: **[lite-player-for-echo360.user.js](https://github.com/zhenban/lite-player-for-echo360/releases/latest/download/lite-player-for-echo360.user.js)** from the latest release (your manager offers to install it). Each release lists what changed.
3. Open any Echo360 lecture recording. The browser console (F12) shows `[Lite Player for Echo360] v… active`.

## Features

- **Low CPU use**: native `<video>` with [hls.js](https://github.com/video-dev/hls.js), using hardware decoding.
- **Two views at once**: show the screen and the camera side by side (drag the divider) or as picture in picture (drag, resize, snap to corners). You can also show a single view. Swap them with one click or `S`. The two views stay in sync. While the screen shows nothing for a long stretch, the camera is shown alone (with Undo; can be turned off).
- **Sharp slides**: always the highest quality the network allows, chosen separately for the screen and the camera.
- **Captions and transcript**: caption overlay in four sizes. A transcript panel follows along with the lecture, lets you click a sentence to jump there, and searches the full text, with matches marked on the progress bar.
- **Notes, bookmarks, "didn't understand" flags and discussion**: these use the same data as the original player, so everything stays in sync with Echo360. Items with a time are marked on the progress bar.
- **Audio tools** (off by default): even out the volume (for lecturers without a microphone), clearer voice, mono.
- **Silence and empty-screen detection**: long pauses (breaks, group work) and stretches with a black or blank screen and nobody speaking are marked on the progress bar, with a Skip button and optional auto-skip. When a recording ends with a long empty part, you are told the lecture is over.
- **Slide chapters**: slide changes in the screen view are found automatically. A Slides tab lists every slide with a picture and what was said; the progress bar shows chapter boundaries and a preview when you hover. `Shift+←` / `Shift+→` move to the previous / next slide.
- **Read along with the slides**: drop the lecturer's slide PDF on the player and the Slides tab turns into a PDF reader that follows the lecture, turning to the page being talked about (it reads the text on screen and finds it in the PDF). Page through it yourself at any time; one click brings you back. The PDF stays on your device.
- **Private tags**: tag notes and bookmarks ("Exam", "Assignment", your own), filter by tag, see tag colours on the progress bar. Tags stay on your device.
- **Zoom and pan**: zoom into the screen, camera or slide PDF with the wheel or a pinch, drag to move, double-click to go back.
- **A-B loop**: replay a stretch (a derivation, a sentence) as often as you like.
- **Watch progress**: what you have watched is shown on the progress bar, and the course page shows a small progress bar for each recording: the parts you watched on this device and where Echo360 says you stopped last time.
- **Floating window**: pop the whole player out into a small window that stays on top while you code or write.
- **English or Chinese**: the interface follows the browser's language (Chinese for any `zh` setting, in simplified characters); change it in ⋮ → Language.
- **Export and backup**: notes, bookmarks and tags as Markdown (with links back to the moment and, with a slide PDF, the slide pictures), for one recording or the whole course. Back up and restore everything that only lives in your browser.
- **No interruptions**: Echo360's video access is renewed in the background, so long sessions do not stop for a reload.
- **Resume**: playback continues where you stopped, across devices (uses Echo360's own record).
- **Honest watch reporting**: viewing progress is reported to Echo360 exactly like the original player, based on what you actually played.
- **Always a way back**: the "Original player" button switches to Echo360's player at the current position. If anything goes wrong, the script falls back to the original player and turns on a CPU fix for it.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` / `→` | Back / forward 5 s |
| `J` / `L` | Back / forward 10 s |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Swap views |
| `C` | Captions |
| `T` | Transcript |
| `B` | Bookmark |
| `U` | "Didn't understand" flag |
| `G` | Tag the note or bookmark here |
| `I` / `O` / `X` | Loop start / loop end / end loop |
| `+` / `-` / `0` | Zoom in / out / whole picture |
| `W` | Floating window |
| `E` | Export and backup |
| `?` | All shortcuts |
| `Shift+←` / `Shift+→` | Previous / next slide |
| `P` | Copy the current picture |
| `A` | Copy what was just said (transcript, last 60 s) |
| `[` / `]` | Slower / faster |
| `Esc` | Close menus |

## Privacy

- The script only runs on Echo360 lecture pages. Apart from Echo360 itself, it sends data to one place only: the anonymous usage data described below, which you can turn off.
- Settings, resume positions and analysis caches are stored only in your browser (localStorage and IndexedDB).
- hls.js is loaded from jsDelivr at a pinned version with its SHA-256 hash (Tampermonkey refuses a file that does not match, and the script then leaves the original player in place; Violentmonkey does not check hashes yet); pdf.js and Tesseract.js (text recognition) are loaded at pinned versions only when a recording has a slide PDF. Text recognition runs in your browser.
- Tags, watch progress, slide files and backups stay on your device. Exports and backups never contain the video or its address.
- Nothing is ever posted for you. Writes to Echo360 (notes, posts, flags) only happen when you click. Anything your instructors or classmates can see is labelled before you send it.
- There is no download feature.

### Anonymous usage data

On by default; **Settings (⋮) > Usage data** turns it off, and sending stops at once. It helps find problems that only show on some computers and decide what to improve.

- **What is sent:**
  - the computer and browser, at most once a day: script, browser, system and script-manager versions, interface language, desktop or touch, screen size and scaling, CPU cores, processor type (x86 or ARM, 32 or 64 bit) and system version where the browser tells, memory and graphics card, the graphics vendor and family WebGPU reports, whether WebGPU, WebCodecs, the browser's built-in AI and CPU pressure readings are available, whether video is decoded in hardware (720p and 1080p), whether the computer was charging, the step of the browser's timer, network type and estimated speed;
  - one summary per viewing:
    - watching: whether it began with the page load, how long until the controls worked and the first picture, how long seeking took (median, 90th percentile), rebuffering (times, share of time), the share of time at each video resolution and how often it changed, the estimated bandwidth, how far apart the two views drifted (median, largest);
    - responsiveness and load: how long clicks and key presses took to be answered (median, 90th percentile, how many over 200 ms), long main-thread tasks, dropped frames, memory, the share of time at each level of CPU pressure and on battery;
    - background analyses: how much they downloaded per hour of recording, the video data per hour played, how many results came from the cache, how soon chapters and the PDF follower were ready, how long each step took (per keyframe, per minute of audio, per million pixels of text recognition and of PDF drawing: median, 90th percentile, count);
    - how fast this computer is: the time per million pixels or audio samples of two fixed pieces of the analyses, which do the same work whatever the recording (10th, 50th and 90th percentile, how many batches, and whether the video was playing, the speed, the CPU pressure and the power source as each batch finished). These come from work the analyses do anyway: nothing extra is run to measure them;
    - stability: features turned off after an error, uncaught errors of the script, failed requests by kind (refused, server error, timed out, no answer), video stream errors by name, renewals of the video access that worked or failed, the version of Echo360's page code (the names of its script files);
    - habits: time open and played, the share of the recording watched, the share of time at each speed and the layout used most, seconds of silence and empty screen skipped, how often each feature was used, keys against clicks, the *names* of settings you changed from their defaults, interface language and theme, how long you watched before switching to the original player;
    - how the analyses did: how the screen view was found, chapters per hour, how much of the time the PDF follower recognised no page, corrections by hand, automatic layout changes undone;
    - the usage data itself: sends that failed, errors left out because too many were queued;
  - switches to the original player and why;
  - errors: the feature, the error type and the message with web addresses, e-mail addresses, quoted text, ids and numbers removed.

  Times and speeds are rounded to two significant digits, and only summaries (medians, percentiles, counts) are sent, never series of values.
- **What is never sent:** your name, account, student number or e-mail; which courses or recordings you watch, their titles or addresses; anything you write (notes, tags, discussion); captions or slide content; your IP address.
- **Where:** a Cloudflare Worker and D1 database run for this project (code in [`telemetry-worker/`](telemetry-worker/)). The Worker keeps only the listed fields and drops everything else. It keeps the country, region and network provider Cloudflare derives from the request, never the IP address; the address only serves as the key of a one-minute rate-limit counter. Requests are not logged. The data is kept with no automatic deletion.
- **Who you are to it:** on first use the script makes a random secret, kept by your script manager and never shown or exported. Your data is stored under the SHA-256 hash of that secret. Viewing or deleting needs the secret itself, so someone who learns the hash can neither read nor delete your data.
- **Your data:** **Settings > Usage data** has *View my data* (a table, and a JSON download), *Delete all my data* (asks first, then deletes at once on the server) and *Reset my ID* (a new secret; it offers to delete the old data first, since the old ID can no longer be used afterwards).
- Greasy Fork's label for this is `@antifeature tracking`.

## Known limitations

- Live lectures and recordings that require a copyright acknowledgement use the original player.
- Polls, slide decks, attachments and audio description are only in the original player (a button takes you there).
- If your school sign-in expires during playback, you will be asked to reload; playback continues from the same position. (Echo360's video access itself is renewed in the background.)
- Slide chapters (without a PDF) learn per recording how large a change makes a new slide; recordings where the screen rarely changes as a whole (a whiteboard filmed by a camera) may get few chapters. If the slides are looked for in the wrong view, choose the right one in the Slides tab.
- Reading along with the slide PDF reads the screen in the language of the PDF (English, Chinese, Japanese, Korean, Russian, Greek, Arabic, Hebrew, Thai, Hindi; others as English). A language other than English downloads its text-recognition data (0.6-2.7 MB) once.
- When a recording has no transcript, silence is detected from the audio, and quiet talk far from the microphone may be marked as silence. Skipping is always your choice unless you turn on auto-skip.

## Development

```sh
npm install        # development tools (ESLint, TypeScript for checking, happy-dom)
npm run build      # src/*.js -> dist/lite-player-for-echo360.user.js (readable, not minified)
npm test           # unit and whole-page tests
npm run ci         # lint, type check, tests, dist/ in sync (what GitHub Actions runs)
```

Only edit `src/` (`dist/` is generated). How the code is organised: [ARCHITECTURE.md](ARCHITECTURE.md).

Source files in `src/` are plain scripts concatenated in name order. Code and comments are in English, user-facing strings live in `src/01-i18n.js`, and every tuning value (with its unit and why it holds) in `src/02-tuning.js`.

## License

Copyright (C) 2026 zhenban. Lite Player for Echo360 is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but without any warranty.

Versions up to and including **v0.14.0** were released under the MIT License; those releases stay under MIT. Later versions are under the GPL.

Libraries loaded at run time (from jsDelivr, pinned versions; not included in this repository):

| Library | Used for | License |
|---|---|---|
| [hls.js](https://github.com/video-dev/hls.js) 1.7.3 | playing the HLS streams | Apache-2.0 |
| [pdf.js](https://github.com/mozilla/pdf.js) (pdfjs-dist 6.4.299) | reading slide PDFs | Apache-2.0 |
| [Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 and tesseract.js-core 7.0.0 | text recognition | Apache-2.0 |
| [tesseract.js-data](https://github.com/naptha/tessdata) 1.0.0 (language data) | text recognition | MIT |

Apache-2.0 and MIT code may be combined with GPLv3 code, so these libraries are compatible with this license.

## Security

See [SECURITY.md](SECURITY.md) for how to report a security problem privately.
