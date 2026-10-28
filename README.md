**English** | [简体中文](README.zh-CN.md)

# Lite Player for Echo360

[![CI](https://github.com/zhenban/lite-player-for-echo360/actions/workflows/ci.yml/badge.svg)](https://github.com/zhenban/lite-player-for-echo360/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/zhenban/lite-player-for-echo360)](https://github.com/zhenban/lite-player-for-echo360/releases/latest)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/bbcmnjnijjfpnngkkgoahjljibfackbh?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/lite-player-for-echo360/bbcmnjnijjfpnngkkgoahjljibfackbh)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

**A faster, smoother player for Echo360 lecture recordings, with tools that help you study:** both views side by side, slide chapters, a slide PDF that turns its own pages, and a searchable transcript. Lectures play smoothly even on older laptops, and your computer stays responsive while you take notes. (How: Echo360's own player keeps a whole CPU core busy while it plays; Lite Player lets the browser play the same video streams itself, with hardware decoding, at about the cost of a plain video file.)

![Lite Player: screen and camera side by side, switching layouts, slide chapters in the side panel](docs/demo-player.gif)

Your notes, bookmarks, discussion and viewing progress stay Echo360's own, and the original player is always one click away.

## Install

Two ways to install the same player, with the same features and settings. Use one or the other, not both.

### Chrome or Edge extension (easiest)

1. Open **[Lite Player for Echo360 in the Chrome Web Store](https://chromewebstore.google.com/detail/lite-player-for-echo360/bbcmnjnijjfpnngkkgoahjljibfackbh)** and click **Add to Chrome**. In Edge, click **Allow extensions from other stores** first when Edge asks.
2. Open any Echo360 lecture recording.

The extension updates itself.

<details>
<summary>Without the store (manual install)</summary>

Download `lite-player-for-echo360-extension-….zip` from the [latest release](https://github.com/zhenban/lite-player-for-echo360/releases/latest) and unzip it. Open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and choose the unzipped folder. A copy installed this way does not update itself: load the new zip when a release comes out. If you move to the store version, remove this copy first.
</details>

### Userscript (every supported browser)

1. **Get a userscript manager:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). In Chrome or Edge, open `chrome://extensions`, click **Details** on the manager and turn on **Allow user scripts** (on older versions, **Developer mode**).
2. **Install Lite Player:** open **[lite-player-for-echo360.user.js](https://github.com/zhenban/lite-player-for-echo360/releases/latest/download/lite-player-for-echo360.user.js)** and click **Install** when the manager asks.
3. **Open any Echo360 lecture recording.** The new player appears in place of the old one.

The manager keeps it up to date; each [release](https://github.com/zhenban/lite-player-for-echo360/releases/latest) lists what changed.

### Where it works

- **Sites:** tested on `echo360.net.au`. Echo360's sites for the US (`echo360.org`), the UK and Europe (`echo360.org.uk`) and Canada (`echo360.ca`) run the same application, so it runs there too, but it has not been tried there yet: if something looks wrong, please [open an issue](https://github.com/zhenban/lite-player-for-echo360/issues). It also works when a learning system shows the recording inside its own page, except for the floating window, and full screen if that page does not allow it.
- **Browsers:** Chrome, Edge and Firefox on computers; Firefox on Android (with Tampermonkey or Violentmonkey).
- **Best effort:** Safari on iPad and iPhone, iOS 15.4 or later, with a userscript manager such as Stay or Userscripts. On an iPhone, full screen shows the main view in the system player, and the audio tools need iOS 17.1.
- **Otherwise:** a page it doesn't recognise, or a browser too old for it, keeps the original player (with a note saying why). On a slow first visit, a loading screen offers the original player at once and opens it by itself after 20 seconds.

## What you get

### Slides, PDF and transcript

- **Slide chapters.** Slide changes are found automatically. The Slides tab lists every slide with its picture and what was said; the timeline shows chapter marks with a preview on hover; `Shift+←` / `Shift+→` jump between slides.
- **The slide PDF follows along.** Drop the lecturer's PDF on the player and it turns to the page being talked about, by reading the text on screen. Page ahead whenever you like; one click brings it back. The file never leaves your computer.

  ![Dropping a slide PDF on the player; it follows the lecture page by page](docs/demo-pdf.gif)

- **Captions and transcript.** Captions in four sizes. The transcript scrolls with the lecture; click a sentence to jump there, or search the whole lecture and see every match on the timeline.

  ![The transcript following the lecture, a search, and a click to jump](docs/demo-transcript.gif)

### Watching

- **Two views at once.** Screen and camera side by side (drag the divider), picture in picture (drag, resize, snap to a corner) or one at a time; swap them with `S`. They stay in sync. When the screen stays empty for a while, the camera takes over (with Undo; you can turn this off).
- **Sharp slides.** The best quality your connection allows, chosen separately for each view.
- **Skip the dead air.** Breaks, group work and blank screens are marked on the timeline, with a Skip button or auto-skip. A long empty ending is called out, so you know the lecture is over.
- **Clearer sound** (off by default): even out a lecturer who wanders from the microphone, sharpen the voice, or switch to mono.
- **Zoom and pan** the screen, the camera or the PDF (wheel or pinch; double-click to reset). **A-B loop** a derivation until it clicks. Pop the whole player into an always-on-top **floating window** while you work.

### Notes and Echo360

- **Notes, bookmarks, "didn't understand" flags and the discussion**, saved to Echo360 as usual and marked on the timeline. `B` adds a bookmark in one key press.
- **Private tags** such as *Exam* or *Assignment*, with filters and coloured marks on the timeline. Tags stay on your device.
- **Export** notes, bookmarks and tags to Markdown, with links back to each moment and, with a slide PDF, the slide pictures. One recording or a whole course. Everything that lives only in your browser can be backed up and restored.
- **See what you've watched:** on the timeline, and as a small bar beside each recording on the course page (what you watched here, and where Echo360 says you stopped). Pick up where you left off, on any device.
- **No interruptions:** video access is renewed in the background, so long sessions need no reload.
- **Honest viewing records:** your viewing is reported to Echo360 exactly as the original player would, from what you actually played.
- **Always a way back:** *Original player* switches to Echo360's player at the same moment. If anything goes wrong, the original player takes over by itself, with a fix that makes it lighter on the CPU.
- English or Chinese, following your browser (or chosen in the menu).

### Good to know

- Live lectures, and recordings that ask you to accept a copyright notice first, open in the original player. So do polls, Echo360's own slide decks, attachments and audio description (one click takes you there).
- If your sign-in expires mid-lecture, you are asked to reload, and playback continues from the same spot.
- Slide chapters come from changes on the screen; a whiteboard filmed by a camera may get only a few. If the wrong view is used for slides, pick the right one in the Slides tab.
- The PDF read-along reads English, Chinese, Japanese, Korean, Russian, Greek, Arabic, Hebrew, Thai and Hindi (other languages as English). Languages other than English download 0.6–2.7 MB of recognition data once.
- Without a transcript, silence is found from the audio, so very quiet speech far from the microphone can be marked as silence. Nothing is skipped unless you choose to, or turn on auto-skip.

## Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | Play / pause | `S` | Swap views |
| `←` / `→` | Back / forward 5 s | `C` / `T` | Captions / transcript |
| `J` / `L` | Back / forward 10 s | `B` | Bookmark |
| `Shift+←` / `Shift+→` | Previous / next slide | `U` | "Didn't understand" |
| `↑` / `↓` · `M` | Volume · mute | `G` | Tag the note or bookmark here |
| `[` / `]` | Slower / faster | `I` / `O` / `X` | Loop start / end / clear |
| `F` | Full screen | `+` / `-` / `0` | Zoom in / out / whole picture |
| `W` | Floating window | `P` | Copy the current picture |
| `E` | Export and backup | `A` | Copy the last 60 s of transcript |
| `?` | All shortcuts | `Esc` | Close menus |

## Privacy

- **Stays with you:** settings, tags, watch progress, analysis results, slide PDFs and backups stay in your browser; notes, bookmarks and discussion stay on Echo360, where they already were. Exports and backups never contain the video or its address, and there is no download feature.
- **Nothing is posted for you:** Echo360 is only written to when you click, and anything your instructors or classmates could see is labelled before you send it.
- **Checked libraries:** hls.js, pdf.js and Tesseract.js run only if they match a pinned SHA-256 hash (the extension ships them; the userscript loads them from jsDelivr). Slide text is read in your browser.

### Anonymous usage data

Apart from Echo360, the player sends data to one place: anonymous usage data, so that problems on other people's computers can be found and fixed. Greasy Fork's label for this is `@antifeature tracking`.

- **Turn it off:** **Settings (⋮) > Usage data**. Sending stops at once. The same page has *View my data*, *Delete all my data* and *Reset my ID*.
- **What is sent:** your computer and browser (at most once a day), one rounded summary per viewing (start-up times, smoothness, responsiveness, which features were used, how well the slide and silence analyses did, errors with personal details removed), switches to the original player with the reason, and which of Echo360's sites it was on and whether inside another site's page. Only summaries, never series of values.
- **Never sent:** your name, account, student number or e-mail; which courses or recordings you watch, their titles or addresses; anything you write; captions or slide content; your IP address.
- **Where it goes:** a Cloudflare Worker and D1 database run for this project (code in [`telemetry-worker/`](telemetry-worker/)). You are known to it only by the hash of a random secret kept by your userscript manager or the extension, out of the page's reach. Only the maintainer reads it, on a private dashboard that shows totals. Every field is listed in [PRIVACY.md](PRIVACY.md).

The only public numbers are the daily active users:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zhenban/lite-player-for-echo360/stats/usage-dark.svg">
  <img alt="Daily active users of Lite Player for Echo360 over the last 90 days" src="https://raw.githubusercontent.com/zhenban/lite-player-for-echo360/stats/usage-light.svg">
</picture>

## For developers

```sh
npm install                # development tools
npm run build              # src/*.js -> dist/lite-player-for-echo360.user.js (readable, not minified)
npm run build-extension    # the Chrome extension -> dist-extension/ and dist-extension.zip
npm test                   # unit and whole-page tests
npm run ci                 # lint, type check, tests, dist/ in sync (what GitHub Actions runs)
```

Edit `src/` only; `dist/` is generated. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the code is organised, and [SECURITY.md](SECURITY.md) how to report a security problem. The usage-data server and its private dashboard are in [`telemetry-worker/`](telemetry-worker/) and [`telemetry-admin/`](telemetry-admin/).

Libraries used at run time, at pinned versions (not in the repository): [hls.js](https://github.com/video-dev/hls.js) 1.7.3, [pdf.js](https://github.com/mozilla/pdf.js) 6.4.299, [Tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core 7.0.0 (Apache-2.0), and Tesseract language data 1.0.0 (MIT).

## License

Copyright (C) 2026 zhenban. Free software under the [GNU GPL v3 or later](LICENSE). Releases up to v0.14.0 were under the MIT License and stay so.

Lite Player is an independent project. Echo360 is a trademark of its owner; the name only says which site this player works on.

The demo lecture in the pictures is made for this project. Its camera view, made with AI video tools, is an unofficial Touhou Project fan work (二次创作): *Touhou Project* is by Team Shanghai Alice / ZUN (上海爱丽丝幻乐团 / ZUN).
