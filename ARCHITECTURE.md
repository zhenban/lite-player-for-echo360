# Lite Player for Echo360: how it is built

This is a guide to the code for someone who knows a little JavaScript. It explains where
things are, how the script starts, who owns what, how the background analyses work and what
is stored where. Details live in the comments at the top of each file; this page tells you
which file to open.

## 1. What runs, and how it is built

Lite Player for Echo360 is a userscript: the browser extension that runs userscripts (Violentmonkey,
Tampermonkey) loads one file, `dist/lite-player-for-echo360.user.js`, into Echo360's lesson pages and
course pages before the page's own scripts run.

The same player is also built as a Chrome extension (`npm run build-extension`): the same
joined `src/` plus `06-platform-extension.js` runs as a content script
in the page's world; `extension/` holds the rest (manifest template, the bridge in the
extension's isolated world, the service worker that sends usage data, icons). If both are
installed, the first copy on a page keeps it and the other does nothing (`00-boot.js`).

That file is made by `node build.mjs` (or `npm run build`) from the files in `src/`:

- the files are **joined in name order** into one function, so a name declared at the top
  of one file (a `const`, `function` or `class`) can be used by all others;
- the result stays readable (no minifying: userscript sites require readable code);
- the build stops if the joined code does not compile, if a source file contains Chinese or
  Japanese characters (all text the user sees is in `01-i18n.js`), or if the pages listed in
  `src/meta.txt` (`@match`) and in `SITE_HOSTS` (`03-common.js`) differ.

`dist/` is committed, and CI checks that it matches `src/` (see section 9). **Only edit
`src/`**: a change made in `dist/` is lost at the next build.

## 2. Map of the source files

The number in front of a file only sets the order in which files are joined. Files that only
declare things (functions, classes, constants) can be in any order; only top-level code that
runs immediately must come after what it uses.

| Files | What they are |
|---|---|
| `00-boot.js` | Runs first: the trap for the page's start-up call (`boot`, a Proxy on `window.Echo`), using nothing else from the script, so it is never late; the start-up record for diagnostics |
| `00-util.js` | Logging, errors (`guard`, `featureGuard`, `reportUnexpected`), `Disposer` (cleaning up), settings store (`store`), small maths and time helpers |
| `01-i18n.js` | Every text the user sees, and `tr(key, values)` |
| `02-tuning.js` | Every tuning number (thresholds, sizes, timings) with its unit and why it holds |
| `03-common.js` | Small shared helpers: `el()` (make an element), `confirmButton`, `makeCanvas`, Echo360 URLs, `mediaDuration`, `fetchSyllabus`, `SITE_HOSTS` |
| `04-types.js` | Descriptions of the data passed around (JSDoc typedefs; no code) |
| `05-platform.js` | Everything that depends on how the player is run (userscript; the extension replaces parts in `06-platform-extension.js`): settings storage, the IndexedDB database, where libraries come from and loading them, hls.js, saving a file, the manager's name, sending to the telemetry Worker, the private store for the telemetry secret, and the page's own window (`page`: with any `@grant` the manager's `window` is a wrapper the page does not see). Other files use only `platform` for these; the build refuses direct `localStorage`, `indexedDB`, `import()`, `GM_`, `unsafeWindow` or `Hls` elsewhere (`unsafeWindow` also in `00-boot.js`, which runs before `platform` exists) |
| `06-platform-extension.js` | Extension build only: `privateKv` in `chrome.storage.local` and `post` through the service worker, both reached through the bridge (`extension/bridge.js`), which it meets at start-up through a node no page script can reach; libraries from the package (`lib/`). `privateReady` resolves once the private values are read |
| `10-adapter-echo360.js` | Everything that knows Echo360's lesson page: catching its start-up call, reading it into a `Lesson` |
| `11-echo360-api.js` | Echo360's data API: notes, bookmarks, flags, discussion; refuses writes without a user action |
| `15-takeover.js` | Taking over a page whose own player started first: while ours plays, the original's watch reports are stopped at the network layer (`netGuard`: `fetch`, `XMLHttpRequest.prototype`, `Navigator.prototype.sendBeacon`); ours carry `OWN_REQUEST` |
| `20-reporter.js` | Watch reporting (what the original player sends Echo360 about viewing) |
| `30-ui-assets.js` | Icons, the stylesheet and the player's HTML template |
| `35-stream.js` | One `<video>` fed by hls.js, with retries and recovery (`Stream`) |
| `36-session.js` | Keeping Echo360's video access alive (`SessionKeeper`) |
| `38-sync.js` | Keeping the second (muted) video in step with the first |
| `39-prefs.js` | Settings: defaults and validation |
| `40-player.js` | `LitePlayer`: builds the player, owns the streams and layout, assembles the parts |
| `41`–`47` | The player's parts: seek bar, keyboard, layout dragging, the camera alone while the screen is empty (`43-empty-screen.js`), quality, menus, floating window, silence controls |
| `50`–`59` | Features: zoom, A-B loop, watched parts, captions and transcript, side panel, notes, tags, discussion, progress-bar markers, notices |
| `60-audio.js` | Audio tools (levelling, clearer voice, mono) with Web Audio |
| `61-media-io.js` | Background media work: playlist parsing, ranged downloads, the IndexedDB store (`idbCache`), the `BackgroundGate` |
| `62-silence.js` | Silence analysis from the transcript or the audio |
| `63-caches.js` | Versions, last use and clean-up of stored analysis results |
| `64-slides.js` | Slide chapters from the screen view; which view is the screen |
| `65-slides-pane.js` | The Slides tab and the PDF reader |
| `66-slide-ocr.js` | Reading the text on screen (Tesseract.js) |
| `67-slide-text.js` | Which PDF page is on screen, from that text (runs in a Worker) |
| `68-slide-deck.js` | The lecturer's PDF files for a recording, and following the lecture |
| `70-cpufix.js` | When the original player is used: a fix for its CPU use |
| `80-course-list.js` | Course page: a small progress bar per recording |
| `85-export.js` | Export (Markdown, zip) and backup / restore |
| `86-diagnostics.js` | "Copy diagnostics" text |
| `87-telemetry.js` | Anonymous usage data: the secret and the id (SHA-256 of it), the daily environment, the summary of each viewing (`UsageSession`), errors and hand-overs to the original player; viewing, deleting and resetting from Settings. The Worker is in `telemetry-worker/` |
| `88-loading.js` | The loading screen while hls.js downloads (intercept path): title, real progress (LIB_BYTES), time waited, tips, "use the original player now" |
| `90-main.js` | Start-up |

## 3. Start-up

```
script runs ──► 00-boot.js: window.Echo trapped (nothing else needed; boot.readyState noted)
                │
                ▼
           90-main.js main()
                ├─ course page (/section/<id>/home)? ──► courseList.start()   (80) ── done
                │
                └─ lesson page: adapter.intercept(onBoot)                      (10)
                     │
     ┌───────────────┴──────────────────────────────┐
     │ page calls Echo["echoPlayerV2FullApp"](json) │ document already complete, call missed
     │ after the trap: path "intercept"             │ (a manager that injects late): path
     │                                              │ "takeover": json read from the page's
     │                                              │ inline script (adapter.bootArg); none ──►
     │                                              │ original stays (noBootData)
     └───────────────┬──────────────────────────────┘
                     ▼
                launch(json, callOriginal, takeover)
                  ├─ settings say "use the original player" ──► original
                  ├─ browser too old (unsupportedReason) ──► original, notice
                  ├─ adapter.parse(json) ──► Lesson   (throws: live lecture, copyright...)
                  ├─ hls.js loaded now (platform.loadHls, hash checked; fails or 20 s ──► original);
                  │    caught before it started: the loading screen meanwhile (LoadingScreen,
                  │    after 0.4 s; its button ──► original at once, a late hls.js is not used)
                  └─ start(): takeover? netGuard.start(), adapter.stopOriginal() (unmount
                       its React root, else take its container out; position and play
                       state carried over) ──► new LitePlayer(lesson, {..., takeover})
                       any throw ──► the original (started again where we were), CPU fix,
                       a notice with the reason and "Copy diagnostics"

   If the page never makes its start-up call (Echo360 changed), the original player stays,
   with the CPU fix and a notice (checked a few seconds after load). Going back to the
   original after a takeover lifts the network stop and puts its container back.
```

Inside `new LitePlayer` (`40-player.js`, `init()`), in this order:

1. read the settings; build the player's DOM in a shadow root over the page;
2. the session keeper and the two streams (`clock`: audio + video; `follower`: video only);
3. the parts (`setupParts()`): seek bar, quality, layout dragging, menus, keyboard, floating window;
4. video events and the control buttons; watched parts; watch reporting;
5. the features, each started on its own (`featureGuard`): silence, slide chapters, slide
   files, captions, notes and discussion, audio tools;
6. load the clock stream at the start position (a `#t=` link, else Echo360's last position,
   else this device's) and lay out the views.

If anything throws during construction, everything made so far is released and the
original player takes over (`startOriginal`).

## 4. Ownership and clean-up: the `Disposer`

Everything that must be undone later (event listeners, timers, observers, child objects)
is registered with a `Disposer` (`00-util.js`) at the moment it is made:

```js
d.listen(button, 'click', fn);        // removed on dispose
d.interval(fn, 1000);                 // cleared on dispose
d.add(() => something.close());       // run on dispose
const part = new SeekBar(deps, d.child());   // the part owns a child: disposed with d
```

Rules:

- **Whoever creates a part owns it** and passes it `parent.child()` (or `feature(name)`).
  The part never disposes what it did not create.
- `d.feature(name)`: a child for an optional feature. An error in that feature's callbacks
  turns off only that feature (one notice: "… was turned off"); playback goes on.
- `d.core()`: for playback itself. An error there hands the page to the original player.
- `player.destroy()` disposes everything; after that the player does nothing (callbacks
  check `destroyed`).

Errors: `guard(fn)` wraps a callback so an exception is logged instead of breaking the page;
in a feature or core disposer it is reported at that level (see the top of `00-util.js`).

## 5. The player and its parts

The player keeps what several parts share: the two streams and which view each plays
(`clockPos`, `followerPos`, `primaryPos`), the layout (`layout`, `pdfMode`), the settings
(`prefs`, `savePrefs()`), `ui.dragging` (something is being dragged), toasts and errors.

Each part gets a small object with only the functions and elements it needs, not the
player itself. For example the seek bar gets `{ $, video, clock, duration, seek, isIdle,
armIdle, markers, ui, previewAt, skipAt }`. That keeps each part readable on its own and
makes it clear what it can change. (The side-panel tabs, `55`–`57` and `65`, still get the
player itself; narrowing them is planned with M9's platform layer.)

Two `<video>` elements play: the **clock** plays audio and video and drives time, reporting
and seeking; the **follower** shows the other view muted and is kept in step (`38-sync.js`),
so the audio is downloaded once. Swapping views side by side only moves the elements; in the
single-view layout the clock is reloaded with the other view. While a stream is (re)loading,
its element says 0 s and paused, so ask the stream (`stream.position()`, `stream.playing()`).

## 6. Background analyses

Three analyses run in the background. They share these rules:

- **Playback first.** Every download waits for the `BackgroundGate` (`61-media-io.js`): it
  runs only while the video is paused or has enough buffered ahead. Nothing runs with the
  browser's Data Saver on.
- **Cached.** Results are stored in IndexedDB with a version (`CACHE_KINDS`, `63-caches.js`);
  a result from another version is made again. Unused results are removed after 60 days.
- **Tolerant.** One unreadable segment is skipped; several in a row stop the analysis,
  keeping what was found (and the next visit continues).
- **Learnt per recording.** Thresholds come from the recording itself (see `02-tuning.js`
  for the few fixed numbers and why they hold).

### Silences (`62-silence.js`, shown by `47-silence-ui.js`)

```
transcript cues ──► gaps between cues ≥ minimum ──► silences
     (none)
audio rendition ──► 60 s chunks (byte ranges) ──► decode to 16 kHz mono
                ──► speech-band level per 0.1 s (envelope, cached) ──► threshold between
                    noise floor (10th percentile) and speech level (90th) ──► silences
silences + empty screens (from slide chapters) ──► skippable stretches ──► marks on the
    bar, Skip button, auto-skip, "the lecture has ended"
```

### Slide chapters (`64-slides.js`)

```
which view is the screen?
   chosen by hand ─► that view
   one view       ─► that view
   else: pairs of keyframes 10 s apart in each view; a screen is still between changes,
         a camera always changes a little ─► the stiller view (a guess if not clear;
         the Slides tab lets the user choose)
keyframes of the screen view, one per 10 s (360p, ~20 KB each, only the keyframe bytes)
   ─► 160×90 brightness picture ─► change against the last visibly different one
   ─► threshold learnt from this recording's changes (Otsu) ─► runs of the same picture
   ─► chapters (returns, short looks elsewhere and flicking merged) ─► each change pinned
      to about a second by decoding that stretch ─► cached
```

The same pictures also say where the screen is one colour (black screen, blank slide).

### Following the PDF (`66`, `67`, `68`)

```
PDF files dropped ─► stored locally (by SHA-256) ─► pages' text (pdf.js)
                  ─► language of the slides ─► text recognition in that language
screen keyframes (720p where the 360p picture changed; else the text is reused)
   ─► Tesseract.js text per distinct picture (cached)
   ─► Worker: words (any script) ─► tf-idf scores per picture and page ─► how scores look
      for right and wrong pages, learnt from this lecture ─► sequence model over time
      (Viterbi) ─► page per sample ─► the page shown while following
```

## 7. What is stored

IndexedDB database `lite-player-for-echo360`, store `cache` (`61-media-io.js` `idbCache`); formats in
`04-types.js`:

| Key | What | Kind |
|---|---|---|
| `slides:<mediaId>` | chapters, screen view, empty-screen stretches | analysis (versioned, pruned) |
| `silence-env:<mediaId>` | audio level envelope | analysis |
| `ocr:<mediaId>:<view>[:<lang>]` | text read on screen | analysis |
| `watched:<lessonId>` | parts watched on this device | user data |
| `tags:<sectionId>`, `tagmap:<mediaId>` | private tags and which item has which | user data |
| `deck:<mediaId>`, `deckref:<hash>`, `deckfile:<hash>` | slide files of a recording | user data |
| `screenpick:<mediaId>` | screen view chosen by hand | user data |

User data is included in backups (`85-export.js`); analysis results are not.
`localStorage` (prefix `lite-player-for-echo360:`): `prefs` (settings), `pos:<id>` (resume point),
`layoutChosen` (recordings whose layout was chosen by hand: no automatic camera-only view),
and the switches below.

## 8. Talking to Echo360

- **Reading:** the lesson page's own data (start-up call), the transcript, player properties
  (course page), notes, discussion.
- **Video:** HLS playlists and segments from Echo360's CDN; access cookies are renewed in the
  background (`36-session.js`) by loading the lesson page again.
- **Watch reporting** (`20-reporter.js`): the same session and heartbeat messages as the
  original player, based on what was actually played.
- **Writing** (notes, bookmarks, flags, discussion) only through `Echo360Api.write`, which
  refuses to run without a trusted user event (a real click or key press). Tested in
  `test/unit.test.mjs` (T1.4).

## 9. Development

```sh
npm install          # ESLint, TypeScript (type checking only), happy-dom (page tests)
npm run build        # src/ -> dist/lite-player-for-echo360.user.js
npm test             # unit tests and whole-page tests (test/*.test.mjs)
npm run lint         # ESLint; no-shadow keeps locals from hiding shared names
npm run typecheck    # TypeScript checks the JavaScript (tsconfig.json, types/)
npm run ci           # all of the above, plus "dist/ matches src/" (what GitHub runs)
npm run check-requires   # each pinned library file (LIB_SHA256) matches the CDN (needs the network; CI runs it)
```

- **Releasing:** set `VERSION`, add the version's section to `CHANGELOG.md`, build, commit,
  then push a tag `vX.Y.Z`. The Release workflow checks everything again and publishes a
  GitHub release with `lite-player-for-echo360.user.js` and that CHANGELOG section.
- **A new library:** load it through `platform.libBlobUrl`/`importLib` and add its path and
  SHA-256 (hex: `sha256sum file`) to `LIB_SHA256` in `src/04-libs.js`, taken from the CDN
  and matched against the npm package. There are no `@require` lines (hls.js too is loaded
  and checked by the script, so the trap in `00-boot.js` waits for no download); one added
  later must carry `#sha256-<base64>`, or `check-requires` fails.

- **Tests** load the sources into a sandbox (`loadSources`), or the whole script into a
  simulated page (`test/player.test.mjs`). Labelled lectures are replayed in the tests from
  `test/fixtures` as hashed word bags (no slide text is in the repository).
- **Switches** in `localStorage` (prefix `lite-player-for-echo360:`): `debug` = `true` (more logging; the
  player is reachable as `window.__litePlayerForEcho360`), `dryRun` = `"public"` or `"all"`
  (writes are recorded, not sent), `forceOriginal` = `true` (always the original player),
  `silenceFromAudio` = `true` (analyse the audio even with a transcript).
- **Changing a threshold:** it is in `02-tuning.js`; run the tests (the labelled lectures
  have accuracy floors), and bump the analysis' version in `CACHE_KINDS` so stored results
  are made again.
- **Adding a part of the player:** a class in its own file taking `(deps, disposer)`;
  create it in `setupParts()` with only the functions it needs and `this.d.child()`.

## 10. Background reading

The code uses some techniques that are not everyday web programming. The comments say what
the code does with them; these explain the ideas:

- Fragmented MP4 (the boxes `moof`, `trun`, `mdat` in `64-slides.js`):
  [ISO base media file format](https://en.wikipedia.org/wiki/ISO_base_media_file_format);
  HLS: [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216).
- Decoding single frames: [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API).
- Audio tools: [Web Audio](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API),
  [DynamicsCompressorNode](https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode).
- The chapter threshold: [Otsu's method](https://en.wikipedia.org/wiki/Otsu%27s_method).
- Matching screen text to pages: [tf-idf](https://en.wikipedia.org/wiki/Tf%E2%80%93idf);
  learning what "right" and "wrong" scores look like:
  [EM for a mixture of Gaussians](https://en.wikipedia.org/wiki/Expectation%E2%80%93maximization_algorithm);
  deciding all pages at once: [hidden Markov model](https://en.wikipedia.org/wiki/Hidden_Markov_model) and the
  [Viterbi algorithm](https://en.wikipedia.org/wiki/Viterbi_algorithm).
- Echo360's endpoints are not documented: they were found by watching the requests the
  original player makes (browser developer tools, Network tab), and this script makes the
  same requests in the same way. If Echo360 changes them, the lesson-page reading
  (`10-adapter-echo360.js`) and the API (`11-echo360-api.js`) are where to look, and the
  tests with the saved page data (`test/fixtures/boot-echo360-classroom.json`) show what
  the code expects.

