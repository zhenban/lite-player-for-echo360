# Chrome Web Store listing

What to enter in the Chrome Web Store developer dashboard for the extension
(`npm run build-extension` makes `dist-extension.zip`; each release has it attached).

## Package
- Upload: `dist-extension.zip`.
- Visibility: **Unlisted** (only people with the link can find it; updates still reach them).
- Version: from the manifest (`VERSION.<extension/BETA>`, shown as "1.0 beta N"). Each upload
  needs a higher version: raise `extension/BETA` for a new beta of the same player version.

## Store listing
- **Name:** Lite Player for Echo360
- **Summary** (132 characters at most; the manifest's description):
  Unofficial, lightweight player for Echo360 lecture recordings: low CPU use, both views side by side, slide chapters.
- **Category:** Education
- **Language:** English
- **Description:**

  > Watch Echo360 lecture recordings without the fan noise.
  >
  > Lite Player replaces the video player on Echo360 lecture pages with one that uses the
  > browser's own video playback, at a fraction of the CPU. It adds the tools you reach for
  > when you study from a recording:
  >
  > - Screen and camera side by side, or picture in picture; swap them with one key.
  > - Slide chapters, found automatically, with previews on the timeline.
  > - Drop the lecture's slide PDF on the player and it turns to the page being talked about.
  > - A transcript that follows the lecture, with search.
  > - Your Echo360 notes and bookmarks on the timeline; skip breaks and blank screens; clearer
  >   sound; zoom; A-B loop.
  >
  > Your notes, bookmarks and viewing progress stay Echo360's own, and the original player is
  > one click away. If a page is not recognised, the original player is used as usual.
  >
  > The player sends anonymous usage data (no names, courses, recordings or anything you
  > write), which you can turn off in its settings. Details:
  > https://github.com/zhenban/lite-player-for-echo360/blob/main/PRIVACY.md
  >
  > Free software (GPL-3.0-or-later): https://github.com/zhenban/lite-player-for-echo360
  > An independent project; Echo360 is a trademark of its owner.

- **Icon:** `extension/icon-128.png` (the package has it too).
- **Screenshots:** 1280 x 800 PNG, at least one, up to five. Made from the demo lecture (no
  real lecture content): `node dev/demo/record-gifs.mjs stills` writes them to `docs/store/`.
- **Small promotional tile** (440 x 280): optional.

## Privacy practices
- **Single purpose:** Replaces the video player on Echo360 lecture recording pages with a
  lighter player that has study tools (two views, slide chapters, a slide PDF that follows the
  lecture, transcript search).
- **Permission justifications:**
  - `storage`: keeps the random secret that identifies the anonymous usage data (out of the
    web page's reach).
  - Host permission `https://lite-player-telemetry.zhenban.workers.dev/*`: the server that
    receives the anonymous usage data, which the user can turn off. Sent by the extension's
    service worker; nothing else is sent there.
  - Content scripts on `/lesson/*` and `/section/*/home` of Echo360's four sites
    (`echo360.net.au`, `echo360.org`, `echo360.org.uk`, `echo360.ca`), also inside frames (a
    learning system may show a recording in one): the pages whose player is replaced (and
    the course list, where watched recordings are marked).
- **Remote code:** No. All code (the player, hls.js, pdf.js, Tesseract.js) is in the package.
  Text-recognition language data for languages other than English is downloaded from
  jsDelivr when first needed; it is data, not code, and checked against a pinned SHA-256.
- **Data usage** (what to tick):
  - *User activity*: yes (which player features are used, counts of clicks against key
    presses, playback smoothness). Anonymous; no browsing outside the lecture page.
  - *Location*: yes, approximate only (the server keeps the country, region and network
    provider that Cloudflare derives from the request; never the IP address).
  - Everything else (personally identifiable information, health, financial, authentication,
    personal communications, web history, website content): no.
  - Certify all three: not sold to third parties; not used or transferred for purposes
    unrelated to the item's single purpose; not used to determine creditworthiness or for
    lending.
- **Privacy policy URL:** https://github.com/zhenban/lite-player-for-echo360/blob/main/PRIVACY.md

## Account
- Developer account and contact e-mail: the maintainer's own (not a school address); the
  e-mail is shown to users on the listing.
