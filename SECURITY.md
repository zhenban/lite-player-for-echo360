# Security

## Reporting a problem

Please report security problems **privately**, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (or go to https://github.com/zhenban/lite-player-for-echo360/security/advisories/new).
2. Describe the problem, how to reproduce it, and what an attacker could do with it.

You will get an answer in the advisory. Please give a reasonable time to fix the problem
before telling others about it.

## What counts

Examples of what to report: a way for a web page or another script to make Lite Player for Echo360
send data somewhere other than Echo360, write to Echo360 without the user's action (notes,
discussion posts, flags), read data it should not, or run code it did not intend to run
(for example through a library loaded at run time).

Problems in Echo360 itself should go to Echo360, and problems in the libraries this script
loads (hls.js, pdf.js, Tesseract.js) to those projects.

## What the script protects, and what it cannot

- **Libraries.** hls.js is loaded by the userscript manager through `@require` with a
  SHA-256 hash. pdf.js, Tesseract.js, its engine and its language data are loaded from
  jsDelivr only when needed, at pinned versions, and each file's SHA-256 is checked before
  it is run or used (`src/04-libs.js`; CI checks the hashes against the CDN). A changed
  file on the CDN makes that feature fail; it is never run.
- **Writes to Echo360** (notes, discussion posts, flags) need a real click or key press
  by the user (`requireGesture`). This protects against the player writing by accident
  (from a timer or a bug). It is not a wall against other code in the page: the player
  runs in the Echo360 page, and any script that runs there (Echo360's own, a browser
  extension, or a page that was tampered with) already has the user's session and can
  call Echo360 directly, with or without this player.
- **Backups** are checked when restored: every entry must have the expected shape, and
  values that are shown (such as tag colours) are limited to plain values.
- **Diagnostics** ("Copy diagnostics") contain no sign-in data or cookies; web and email
  addresses are masked, and errors from Echo360 keep only their status code. Other error
  messages are kept as they are, so the text is shown in full before anything is copied,
  and it is only copied, never sent.

## Supported versions

Only the latest release gets security fixes.
