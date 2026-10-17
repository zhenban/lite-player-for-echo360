# Telemetry dashboard

A private, read-only web page that shows how Lite Player for Echo360 is being used: how many
people use it, on which devices, whether it runs smoothly, what goes wrong, which features get
used, and whether an Echo360 change has broken it. It reads the D1 database `telemetry` that
`telemetry-worker/` writes to. It is a separate Cloudflare Worker (`lite-player-dashboard`),
so the Worker that receives the data has no read endpoint. This directory holds no secrets.

It works on desktop and phone, in light and dark (follows the system, or pick one), in
English, with Chinese as the second language (`中文` button).

## What the page shows

- **Active users**: the count for the chosen range, the change from the range before, and a
  daily sparkline.
- Five summary tiles with a status (fine / worth a look / problem / too few to judge): most
  common setup, smoothness, viewings with problems, features in use, Echo360 compatibility.
- Six sections, each opened by a one-sentence finding:
  - **Users**: daily active users, script versions, new users, share of each recording
    watched, silence skipped, keyboard use, country / region / network;
  - **Devices**: browser, system, device type, script manager, screen width, CPU cores,
    memory, graphics, 1080p decoding, WebGPU, WebCodecs;
  - **Performance**: dropped frames, click response (slowest 10 %), long tasks, start-up
    and seek times, buffering, memory and CPU load, with medians against their limits and a
    per-version table;
  - **Stability**: viewings with a problem per day, what went wrong, the most frequent
    errors (feature, message, count, versions, last seen);
  - **Features**: share of users who used each feature, features never used, settings
    changed from the default, playback speeds, where slide chapters came from (the video's
    keyframes, or only Echo360's per-minute preview pictures), why the keyframe scan
    stopped early, and which form of the video gave it pictures (as sent, converted to
    Annex B, or neither) per system and browser version;
  - **Echo360 compatibility**: page loads sent to the original player and why, the
    versions of Echo360's page code seen (a new one usually means Echo360 changed its
    player), and how the script started.
- Filters: 7 / 30 / 90 days, script version, and **Exclude my devices** (off by default;
  hides the uids listed in `OWNER_UIDS`).

Only totals. There is no per-user view and the page never shows a uid. Every block states its
sample size; under 5 it is dimmed and marked "Too few to judge". The limits used for the
statuses are in `src/summary.js` (`LIMITS`). Apart from click response, which follows
Google's INP limits (200 ms / 500 ms), they are starting points to adjust once there is more
data.

## Security model

Two independent locks, so a mistake in one does not expose anything:

1. **Cloudflare Access** in front of the Worker, allowing only the owner's Google account.
2. **The Worker checks again on every request** (`src/auth.js`), before it routes anything:
   - its settings must be present and valid (`TEAM_DOMAIN`, `POLICY_AUD`,
     `ALLOWED_EMAILS`), otherwise every request gets 503;
   - the Access token (`Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie)
     must verify against the team's public keys (`<team>/cdn-cgi/access/certs`): RS256,
     issuer = the team domain, audience = the application's AUD tag, not expired;
   - the token's email must be in `ALLOWED_EMAILS`.

   Anything else gets 403, with no data. If Access is switched off or misconfigured, no valid
   token arrives and the Worker still refuses. There is no bypass, not even for local
   previews (`dev/serve.mjs` signs its own tokens with a throwaway key instead).

Read-only:

- Only `GET` and `HEAD`; anything else gets 405.
- The only data endpoint is `GET /api/summary?range=&version=&devices=&tz=`. Unknown
  parameters or invalid values get 400. The page cannot send SQL.
- The SQL is a fixed list in `src/queries.js`. When the Worker loads, every statement is
  checked: it must start with `SELECT` or `WITH`, and contain no `;`, comments, or writing
  keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `PRAGMA`,
  `ATTACH`, …). Filter values are always bound parameters.
- D1 has no read-only binding, so the code is what keeps it read-only. The tests run every
  statement, with every filter combination, against SQLite opened with
  `PRAGMA query_only = ON`, where any write fails.

Responses: `Cache-Control: no-store`, a strict Content-Security-Policy (only this Worker's own
script, style and font; no inline script, no external requests, cannot be framed),
`X-Frame-Options: DENY`, `nosniff`, no CORS headers. Nothing is logged and `observability` is
off. The font is bundled, so the page loads nothing from other sites.

## Files

- `src/index.js`: the Worker (checks, routes, headers).
- `src/auth.js`: settings and the Access token check.
- `src/queries.js`: the fixed, checked SQL.
- `src/summary.js`: filters, turning query results into the page's data, statuses.
- `src/page/`: the page (`index.html`, `app.css`, `i18n.js`, `format.js`, `charts.js`,
  `app.js`). `build-assets.mjs` packs it, with the font, into `src/assets.gen.js`
  (generated, not committed); `npm test`, `npm run dev` and `npm run deploy` run it first.
- `test/`: access control, read-only, summary and page tests.
- `chart/`: the public usage chart (see below).
- `dev/`: made-up data (`seed.mjs`), local preview (`serve.mjs`), screenshots (`shoot.mjs`).
  `dev/migrations/` holds copies of telemetry Worker migrations this branch's
  `telemetry-worker/` does not have yet; the test schema skips a copy once the Worker's own
  file of the same name is present, so they can be deleted after a merge.

## Tests and local preview

```sh
cd telemetry-admin
npm install
npm run ci            # eslint + tests
npm run dev           # preview with made-up data on http://127.0.0.1:8790
node dev/serve.mjs solo 8791    # scenarios: busy (default), solo, empty
```

The preview uses Node's built-in SQLite with made-up data. It never touches the real
database.

The tests cover: requests without a token, with a forged / expired / wrong-audience /
wrong-issuer token, a token for another email, and with missing or invalid settings are
refused (403 / 503) without touching the database; `POST` / `PUT` / `PATCH` / `DELETE` are
refused (405); SQL or unknown parameters in the query string are refused (400); every query
runs on a read-only database; no uid appears in any response; the summary's numbers and statuses for empty, single-user and
busy data.

## Deploying (owner, once)

Everything below is done by the owner. Nothing secret goes into the repository: the four
settings are stored in Cloudflare as encrypted Worker secrets.

> **Important:** do not turn on "Protect all Workers" (or any Access rule covering all of
> `*.workers.dev`) in Zero Trust. It would also block the player's usage data going to
> `telemetry-worker`. Protect only the `lite-player-dashboard` Worker, as below.

### 1. Deploy the Worker

```sh
cd telemetry-admin
npm install
npx wrangler login      # if not logged in already
npm run deploy          # prints https://lite-player-dashboard.<subdomain>.workers.dev
```

Until step 4 is done the page answers 503 to everyone (no settings yet), which is expected.

### 2. Zero Trust and Google login (about 10 minutes)

1. Cloudflare dashboard → **Zero Trust**. The first time, pick a team name (the Free plan is
   enough). The team domain is `https://<team>.cloudflareaccess.com`; it is shown under
   **Settings → Custom pages** (or **Team name and domain**).
2. Google Cloud Console (<https://console.cloud.google.com/>) → create a project (any name)
   → **APIs & Services → OAuth consent screen**: user type **External**, app name e.g.
   "Lite Player dashboard", your email as support and developer contact. Under **Audience /
   Test users** add your own Google address. It can stay in testing mode; only you sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://<team>.cloudflareaccess.com`
   - Authorized redirect URIs: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`

   Copy the **Client ID** and **Client secret**.
4. Zero Trust → **Settings → Authentication → Login methods → Add new → Google**. Paste the
   client ID and secret, save, then **Test**. It should show your Google account's email.

### 3. Put Access in front of the dashboard Worker

1. Cloudflare dashboard → **Workers & Pages → lite-player-dashboard**.
2. **Settings → Domains & Routes** → on the `workers.dev` row, **Enable Cloudflare Access**
   (newer dashboards also have an **Access** tab on the Worker: **Protect this Worker behind
   Access**). This creates an Access application for the Worker.
3. Open that application (Zero Trust → **Access → Applications → lite-player-dashboard**,
   or the "Manage" link) and set:
   - **Login methods**: only **Google** (turn off "One-time PIN" so nobody can log in with
     an emailed code).
   - **Policy**: action **Allow**, include **Emails** = your Google address only. Remove any
     default policy that allows more.
   - Session duration: e.g. 24 hours.
4. On the application's **Overview / Basic information**, copy the **Application Audience
   (AUD) Tag** (64 hex characters).

### 4. Give the Worker its settings

```sh
cd telemetry-admin
npx wrangler secret put TEAM_DOMAIN       # https://<team>.cloudflareaccess.com
npx wrangler secret put POLICY_AUD        # the AUD tag from step 3.4
npx wrangler secret put ALLOWED_EMAILS    # your Google address (comma-separated for more)
npx wrangler secret put OWNER_UIDS        # optional, see below
```

`OWNER_UIDS` is for **Exclude my devices**: a comma-separated list of your devices' uids
(64 hex characters each). While you are the only user, every uid in the database is yours:

```sh
cd telemetry-worker
npx wrangler d1 execute telemetry --remote --command="SELECT uid, MIN(at) AS first_seen, COUNT(*) AS rows FROM env GROUP BY uid"
```

Later, a new device of yours shows up as a new uid with a first-seen time you recognise.
Without `OWNER_UIDS` the toggle simply changes nothing.

### 5. Check it

1. In a private window, open the dashboard address. You should get the Cloudflare Access
   login page, not the dashboard. Sign in with Google: the dashboard loads.
2. From a terminal (not logged in):
   ```sh
   curl -sI https://lite-player-dashboard.<subdomain>.workers.dev/api/summary
   ```
   should give a redirect to `<team>.cloudflareaccess.com` (Access) or `403`. Never `200`.
3. If you can log in but the dashboard says 403: the Worker did not get a valid token for
   your email. Check that `TEAM_DOMAIN` has no typo, `POLICY_AUD` is the AUD of *this*
   application, and `ALLOWED_EMAILS` is the address you logged in with. (The Worker fails
   closed, so a mistake here never exposes data.)
4. Try signing in with a different Google account: Access should refuse it.

### Updating

`npm run deploy` again. The secrets stay. Nothing in this directory needs redeploying when
`telemetry-worker` changes, unless its tables change (then the queries in `src/queries.js`
and the tests' schema, read from `../telemetry-worker/migrations`, follow).

## Public usage chart

A small chart for the main README: active users in the last 30 days, the total since the
first report, and daily active users over the last 90 days (UTC days). It shows totals only:
no uid, no per-user numbers, nothing about devices.

- `chart/usage-chart.mjs` asks D1 for two fixed statements (checked by the same read-only
  `compile()` as the dashboard's) through Cloudflare's HTTP API and writes
  `usage-light.svg` and `usage-dark.svg`.
- `.github/workflows/usage-chart.yml` runs it daily (04:23 UTC, or by hand from the Actions
  tab) and force-pushes the two files to the `stats` branch, as one commit each time, so the
  branch never grows. Nothing is committed to `main`.
- `test/chart.test.mjs` checks the counts against the made-up data, that the SVGs contain no
  ids, and that the token is sent only to the D1 query endpoint and never appears in errors.

### Setting it up (owner, once)

1. **A read-only Cloudflare API token.** Cloudflare dashboard → your profile → **API Tokens →
   Create Token → Create Custom Token**:
   - Name: e.g. `lite-player usage chart (D1 read)`
   - Permissions: **Account → D1 → Read** (only this one)
   - Account Resources: Include → your account
   - Leave IP filtering empty (GitHub's runners have changing addresses). A TTL is optional;
     if you set one, the chart stops updating when it expires.

   Create it and copy the token (it is shown once).
2. **Two GitHub Actions secrets** (repository → Settings → Secrets and variables → Actions →
   New repository secret, or `gh secret set NAME`, which asks for the value):
   - `CLOUDFLARE_D1_READ_TOKEN`: the token
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID (`npx wrangler whoami` shows it)
3. Once the workflow is on `main`: Actions → **Usage chart** → **Run workflow**. The `stats`
   branch appears with the two SVGs.
4. In the main README:

   ```html
   <picture>
     <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zhenban/lite-player-for-echo360/stats/usage-dark.svg">
     <img alt="Daily active users of Lite Player for Echo360 over the last 90 days" src="https://raw.githubusercontent.com/zhenban/lite-player-for-echo360/stats/usage-light.svg">
   </picture>
   ```

The token stays in GitHub's encrypted secrets. Workflows started from forks or pull requests
do not get it, and this workflow runs only on the schedule or by hand, only in this
repository. It can read the raw rows if it ever leaks, so if that happens revoke it in
Cloudflare (API Tokens → Roll or Delete) and create a new one.

## Wrangler's own usage statistics

As in `telemetry-worker/`, `.env` here sets `WRANGLER_SEND_METRICS=false`.
