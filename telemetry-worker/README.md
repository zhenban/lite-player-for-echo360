# Telemetry Worker

Receives the anonymous usage data of Lite Player for Echo360 (what is collected and why: the
"Anonymous usage data" section of the main README). Cloudflare Workers + D1. This directory
holds no secrets.

- `src/index.js`: the endpoints (all `POST`, JSON body):
  - `/v1/register` `{ uid, secret, day, nonce }` registers a user once (see "Abuse");
  - `/v1/events` `{ uid, ts, batch, sig, body }` stores events signed by a registered user
    (`body` is the JSON text of `{ events: [...] }`); players before 0.25.0 send
    `{ uid, events: [...] }` unsigned, stored with `auth = 0`. At most 25 events per
    request, 24 KB;
  - `/v1/me` `{ uid, secret }` returns everything stored for that user, with the
    registration (without its key);
  - `/v1/me/delete` `{ uid, secret }` deletes it, the registration included.

  `uid` must equal SHA-256 of `secret` (hex). The secret is never stored. Every answer of
  `/v1/events` and `/v1/register` carries the Worker's clock (`now`, ms).
- `src/schema.js` lists the fields kept per kind of event (`env`, `session`, `error`, `fallback`)
  with their checks. Unknown fields are dropped, and invalid values are stored as NULL. The
  main repository's `test/telemetry.test.mjs` runs the Worker against SQLite and checks that
  the player sends only listed fields.
- `migrations/` holds the tables and indexes (uid, time, version), one file per change
  (`npm run migrate` applies the ones not applied yet).
- Fixed steps (`luma_*`, `loud_*`): `*_v` is the version of the timed code. Compare only
  rows of the same version; the queries use the newest.
- `queries/` holds the usual questions, see below.

Nothing is logged. The Worker writes nothing to the console, and `observability` is off in
`wrangler.toml`. The sender's address is used only as the key of the rate limits (30
requests a minute for events, 3 for registering, 5 for viewing and deleting). Each user
also has a limit of 10 batches a minute, keyed by the uid. Country, region and network
provider come from Cloudflare's `request.cf` and are stored with each row.

## Abuse

The client is open source, so any check it does can be copied: nothing here relies on a
hidden key. The aim is to make false data costly and visible, without CAPTCHAs, third-party
scripts or fingerprints.

- **Registration** (`src/auth.js`). The player's uid is SHA-256 of a random secret. Once, it
  sends `{ uid, secret, day, nonce }`: the Worker checks the secret, checks the proof of work
  (`SHA-256("lp-mint-v1|" + uid + "|" + day + "|" + nonce)` starts with `MINT_BITS` zero
  bits; `day` is days since 1970-01-01 UTC, within one of the Worker's), and keeps
  `kv = HMAC-SHA-256(secret, "lp-ingest-v1")` in `uid_keys`. The player does the work in
  ~20 ms idle slices during a viewing. Registering again keeps the first day. A registration
  costs 2 writes of the daily budget and is refused with 503 when the budget is spent.
- **Signed batches.** `sig = hex HMAC-SHA-256(kv, ts + "." + batch + "." + hex SHA-256(body))`,
  `batch` 24 random hex digits, `ts` the sender's time in ms. Refused with 401: a `ts` more
  than 10 minutes from the Worker's clock (`{ error: "clock", now }`; the player corrects and
  signs again), an unknown uid (`{ register: true }`), a wrong signature. A batch id already
  stored (table `batches`, kept a day) is not stored again (`{ duplicate: true }`). With
  `ENFORCE_MINT_POW` on, a user registered without a proof of work (while it was off) gets
  `{ register: true }` and must register again with one.
- **Quotas.** Per user and UTC day: 40 new viewings (a viewing already stored that day may be
  updated), 50 errors, 50 switches to the original player; one environment row a day anyway.
  Events over a quota are dropped. Within one batch, the environment rows and the updates of
  one viewing are written once (the last). Each user also has `USER_DAILY_WRITES` (3,000)
  writes a day, counted as the budget is and updates included (table `uid_budget`); past
  them nothing more is stored that day (`{ stored: 0, quota: true }`).
- **Checked with the writes.** The quotas and the budget are read before the writes, and
  checked again by the last statement of the same D1 transaction (it inserts into
  `overdraw`, whose check always fails, when a limit was passed): requests arriving together
  cannot all pass. Such a request is answered 503 `{ error: "busy" }` with nothing written.
- **Unsigned rows never replace signed ones.** An unsigned update of an environment row or a
  viewing stored from a signed batch is ignored.
- **Daily budget.** `DAILY_WRITE_BUDGET` rows written a day in all, counted as D1 counts them
  (each row plus each index it updates: `WEIGHT` in `src/index.js`), in table `budget`. When
  spent: 503 for unsigned batches and users registered less than 3 days ago; older registered
  users store only their environment row, once a day, within `ESTABLISHED_RESERVE` beyond the
  budget. Viewing and deleting always work (they are limited by address only).
- **Flags** (`src/plausibility.js`). Values the player cannot produce set a bit in the row's
  `flags` (stored anyway): played longer than open, an analysis longer than the page was
  open, first picture after 2 minutes, slide chapters without a slide source, video data per
  hour outside 20-3000 MB, timings with more than two significant digits.
- **Cron.** Daily at 03:17 UTC: batch ids and per-user counts older than a day, and budget
  rows older than 30 days, are deleted.

Variables (`[vars]` in `wrangler.toml`; `"1"` turns a check from noting into refusing):

| Variable | Default | Effect |
| --- | --- | --- |
| `ENFORCE_AUTH` | `"0"` | refuse unsigned batches (players before 0.25.0) with 401 |
| `ENFORCE_MINT_POW` | `"0"` | refuse registrations without a valid proof of work with 403 `{ error: "pow", bits }`, and batches of users registered without one with 401 `{ register: true }` |
| `MINT_BITS` | `"21"` | zero bits the proof of work needs; the player's `TELEMETRY_MINT_BITS` should match (a higher value here makes players do the work again) |
| `DAILY_WRITE_BUDGET` | `"60000"` | rows written a day (D1's free plan allows 100,000) |
| `ESTABLISHED_RESERVE` | `"10000"` | writes beyond the budget for the daily environment rows of users registered 3+ days ago |

Rows carry `auth` (1: from a signed batch) and `flags`. `uid_keys.pow_ok` says whether the
registration had a valid proof of work.

## Wrangler's own usage statistics

Wrangler sends Cloudflare statistics about how it is used unless told not to. `.env` in this
directory sets `WRANGLER_SEND_METRICS=false`, and wrangler reads it whenever it runs here
(`npx wrangler telemetry status` shows "Disabled (set by WRANGLER_SEND_METRICS)"). Running
wrangler from another directory needs the variable set in the shell:

```sh
export WRANGLER_SEND_METRICS=false
```

## Deploying

```sh
cd telemetry-worker
npm install
npx wrangler login
npx wrangler d1 create telemetry      # once; put the database_id it prints into wrangler.toml
npm run migrate                       # applies migrations/ to the remote database
npm run deploy                        # prints the workers.dev address
```

The player sends to `TELEMETRY_URL` in `src/87-telemetry.js`, and `@connect` in
`src/meta.txt` must name the same host (the build checks this).

## Queries

```sh
npx wrangler d1 execute telemetry --remote --command="$(cat queries/active-users.sql)"
```

(`--file` runs the file but prints only a summary, not the rows.)

| File | Answers |
|---|---|
| `active-users.sql` | active users per day and week |
| `versions-browsers.sql` | script versions, browsers, systems, script managers, desktop/touch |
| `regions.sql` | countries, regions, network providers |
| `performance.sql` | load and watching per version: median and 90th percentile of long tasks, dropped frames, memory, start, seeking, rebuffering, sync, interaction delay, analysis times and their time per unit of work |
| `device-tiers.sql` | devices (user ids) in four tiers by their fixed-step time (`luma`, the median over the device's viewings of the 10th percentile; `loud` alongside): dropped frames, interaction delay, long tasks and CPU pressure with and without background analyses, per tier |
| `fixed-steps.sql` | the fixed steps by browser, system and cores: median of the viewings' 10th percentile and median, per step version |
| `work-vs-steps.sql` | rank correlation over devices between the fixed steps and the measures of real work (do the steps say how fast the work goes?) |
| `startup.sql` | how the script started, per browser and script manager: caught the page's player, took it over, or left it; the page's state then, time until the player was shown, watch reports stopped |
| `stability.sql` | features turned off, failed requests by kind, video stream errors, the usage data's own failures |
| `habits.sql` | time at each speed and resolution, theme, language, share watched, silence and empty screen skipped, switches to the original player |
| `errors.sql` | most frequent errors |
| `fallbacks.sql` | why pages went to the original player, with Echo360 front-end versions |
| `features.sql` | share of users using each feature |
| `changed-defaults.sql` | share of users who changed each setting |
| `webgpu.sql` | WebGPU, WebCodecs, built-in AI, CPU pressure readings and hardware video decoding by browser |
| `algorithms.sql` | screen detection, chapters per hour, PDF follower, corrections, layout undos, access renewals |
| `check-columns.sql` | the columns of every table (only the listed fields exist) |

## Deleting one user's data

Users delete their own data from the player (Settings > Usage data). If someone sends their
uid (for example from the downloaded JSON) and asks for deletion by other means:

```sh
UID=<64 hex characters>
for t in env sessions errors fallbacks uid_keys batches; do
  npx wrangler d1 execute telemetry --remote --command "DELETE FROM $t WHERE uid = '$UID'"
done
```

Check that the value is exactly 64 hexadecimal characters before running it.
