# Chrome Web Store listing

What to enter in the Chrome Web Store developer dashboard for the extension
(`npm run build-extension` makes `dist-extension.zip`; each release has it attached).

## Package
- Listing: https://chromewebstore.google.com/detail/lite-player-for-echo360/bbcmnjnijjfpnngkkgoahjljibfackbh
- Upload: `lite-player-for-echo360-extension-X.Y.Z.zip` from the release (the same as
  `dist-extension.zip`).
- Visibility: **Public** (since 2026-10-25; 1.0.0.1 "1.0 beta 1" was the first, unlisted).
- Version: the player's version (`VERSION`). Each upload needs a higher one than the last.

## Store listing
The store takes plain text only (no Markdown): paste the descriptions below as they are.
The name and summary are not typed in: they come from the package (`extension/_locales/`),
English by default and Chinese for Chinese-language accounts. Without a Chinese description
the store shows a machine translation of the English one.

- **Category:** Education
- **Language:** English (default), plus **Chinese (China)** with its own description.

### Description: English

```text
A faster, smoother player for Echo360 lecture recordings, with tools that help you study.

Lite Player replaces the video player on Echo360 lecture pages. Lectures play smoothly, even on older laptops, and your computer stays responsive while you take notes. It also adds:

• Screen and camera side by side, or picture in picture. Swap them with one key.
• Slide chapters, found automatically, with previews on the timeline.
• Drop the lecture's slide PDF on the player and it turns to the page being talked about.
• A transcript that follows the lecture, with search.
• Your Echo360 notes and bookmarks on the timeline. Skip breaks and blank screens, clearer sound, zoom, A-B loop.

Your notes, bookmarks and viewing progress stay Echo360's own, and the original player is one click away. If a page is not recognised, the original player is used as usual.

The player sends anonymous usage data (no names, courses, recordings or anything you write), which you can turn off in its settings. Details: https://github.com/zhenban/lite-player-for-echo360/blob/main/PRIVACY.md

Free software (GPL-3.0-or-later): https://github.com/zhenban/lite-player-for-echo360
An independent project; Echo360 is a trademark of its owner.
```

### Description: Chinese (China)

```text
更快、更流畅的 Echo360 课程回放播放器，还有帮你学习的工具。

Echo360 轻量播放器替换 Echo360 课程回放页面上的播放器。回放播放流畅，旧电脑也不卡，边看边记笔记时电脑照样顺手。它还带来：

• 屏幕和摄像机画面并排，或画中画；一个键交换两个画面。
• 自动找到幻灯片切换，生成章节，进度条上可以预览。
• 把这节课的幻灯片 PDF 拖到播放器上，讲到哪一页就自动翻到哪一页。
• 跟随讲课滚动的转录，可以搜索。
• 你在 Echo360 的笔记和书签显示在进度条上。跳过课间休息和黑屏，人声增强，画面缩放，A-B 循环。

笔记、书签和观看进度仍是 Echo360 自己的数据；原播放器随时一键切回。认不出的页面照常使用原播放器。

播放器会发送匿名使用数据（不含姓名、课程、录像和你写的任何内容），可以在设置里关闭。详情（英文）：https://github.com/zhenban/lite-player-for-echo360/blob/main/PRIVACY.md

自由软件（GPL-3.0-or-later）：https://github.com/zhenban/lite-player-for-echo360
独立项目；Echo360 是其所有者的商标。
```

- **Icon:** `extension/icon-128.png` (the package has it too).
- **Screenshots** (1280 x 800, in this order): `docs/store/1-compare.png`, `2-slides.png`,
  `3-pdf.png`, `4-ask-ai.png`, `5-revise.png`.
- **Small promotional tile** (440 x 280): `docs/store/promo-small.png`.
- **Marquee promotional tile** (1400 x 560): `docs/store/promo-marquee.png`.
- All are made from the demo lecture (no real lecture content) by `dev/store-art/v3/`
  (`capture.mjs` takes the player pictures, `render.mjs` the images; `dev/` is local only).

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
