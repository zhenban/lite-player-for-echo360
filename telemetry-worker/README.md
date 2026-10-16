# Telemetry Worker

Receives the anonymous usage data of Lite Player for Echo360 (what is collected and why: the
"Anonymous usage data" section of the main README). Cloudflare Workers + D1. This directory
holds no secrets.

- `src/index.js`: the endpoints (all `POST`, JSON body):
  - `/v1/events` `{ uid, events: [...] }` stores events (at most 25 per request, 16 KB);
  - `/v1/me` `{ uid, secret }` returns everything stored for that user;
  - `/v1/me/delete` `{ uid, secret }` deletes it.

  `uid` must equal SHA-256 of `secret` (hex). The secret is only hashed, never stored.
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
requests a minute for events, 5 for viewing and deleting). Country, region and network
provider come from Cloudflare's `request.cf` and are stored with each row.

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
for t in env sessions errors fallbacks; do
  npx wrangler d1 execute telemetry --remote --command "DELETE FROM $t WHERE uid = '$UID'"
done
```

Check that the value is exactly 64 hexadecimal characters before running it.
