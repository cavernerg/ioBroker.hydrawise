![Logo](admin/hydrawise.jpg)

# ioBroker.hydrawise — v2-API fork

Fork of **[SentiQ/ioBroker.hydrawise](https://github.com/SentiQ/ioBroker.hydrawise)** (based on 1.0.6).
Everything the original adapter does is unchanged — v1 zone control, `schedule.*` and `customer.*`
work exactly as before. This README only lists what the fork adds; for the general description,
the API key and the original documentation see the [upstream README](https://github.com/SentiQ/ioBroker.hydrawise#readme).

Not published on npm:

```bash
iobroker url https://github.com/cavernerg/ioBroker.hydrawise
```

## 1. Hydrawise v2 API — water usage and sensor readings

The v1 REST API reports only the *configuration* of the connected sensors (`input`, `type`, `mode`,
`timer`, `offtimer`, `rate`), not a single measured value. Water usage, rainfall and the triggered
state of a rain sensor cannot be read through it at all.

The v2 API (OAuth2 + GraphQL, `app.hydrawise.com/api/v2/graph`) — the one the Hydrawise app uses —
does report them. Enable **"Use API v2"** in the instance settings and enter the e-mail address and
password of your Hydrawise account. An API key alone is not enough: Hunter does not hand out client
registrations for the v2 API, so the client credentials of the official app are used with a password
grant (same approach as [pydrawise](https://github.com/dknowles2/pydrawise)). The password is listed
in `encryptedNative`/`protectedNative` and stored encrypted.

New states, all of them additive:

| Channel | States |
|---|---|
| `water.*` | `today`, `yesterday`, `week`, `month`, `year`, `todayActive`, `todayInactive`, `todayRuntime` (same for `yesterday*`), `leakSuspected`, `lastUpdate` |
| `zones.<n>.*` | `waterToday`, `runtimeToday`, `lastRunStart/End/Duration/Water/Status/Ok`, `scheduleStatus`, `running`, `remainingTime`, `currentWater`, `nextRun`, `nextRunDuration`, `waterBalance`, `suspendedUntil`, `id`, `name`, `status` |
| `sensors.<input>.*` | `active` (rain sensor triggered — missing from v1 entirely), `type`, `model`, `terminal`, `name`, `waterFlow` |
| `weather.*` | `rainfallLast24h`, `rainfallLast7d`, `temperature`, `temperatureMax` — only created when the weather station actually reports values |
| `controller.*` | `online`, `status`, `lastContact`, `name`, `model`, `serialNumber`, `firmwareVersion`, `waterSavings` |
| `info.connectionV2` | connection state of the v2 API |

Four queries run per poll (snapshot, today's flow summary, today's watering report, one rotating
long-term period), each evaluated on its own so a single failing query leaves the other states up to
date. Default interval 5 minutes, independent of the v1 interval.

## 2. Leak detection

`water.todayInactive` is the volume that flowed today outside of any watering run (flow meter total
minus the sum of the reported runs). Exceeds it the configured threshold — in the unit of your
account, default 20, `0` disables the check — `water.leakSuspected` is set. The verdict is suspended
while a zone is running, because the report only records a run once it has finished and the flow
meter is ahead of it until then — and for the same reason (plus runs that span midnight) it only
latches once two consecutive polls agree.

## 3. Fixes in the v1 branch

- **429 retry never worked.** `buildRequest()` wrapped every axios error into `new Error(error)`,
  which dropped `response.status` and `code`. The rate limit handling in `GetStatusSchedule()` and
  `GetCustomerDetails()` could therefore never trigger: after a single rate limited request the poll
  interval stayed cleared and `customer.*` went stale until the next adapter restart.
- **Hanging promise in the same code path.** Its 429 branch settled the promise neither with
  `resolve` nor `reject`. That only became visible once the fix above made the branch reachable —
  `await this.GetCustomerDetails()` in `onReady()` then hung forever.
- **`last_contact` was always parsed as an epoch value**, but the API also answers `"Unknown"`,
  which left the state at `Invalid Date`.
- **No shutdown guard** — every restart wrote "DB closed" errors into the log.

## 4. v1 rate limit handling

`customerdetails.php` allows only **5 requests per 5 minutes** and the counter is stickier than
documented. It now polls on its own interval (default 30 minutes, `customerInterval`), is paused
with a growing backoff (5 → 30 minutes) after an HTTP 429 instead of being hammered, and a rate
limit no longer sets `info.connection` to false. Note for existing installs: the upstream
adapter polled this endpoint every 5 minutes, so `customer.*` (controller name, serial number)
now refreshes six times less often unless you lower `customerInterval`.

## 5. Diagnostics

```bash
cd /opt/iobroker/node_modules/iobroker.hydrawise
node tools/check-v2.js 0
```

Reads the credentials from the instance configuration (decrypted through `tools.decrypt` of
`@iobroker/js-controller-common`), runs every query and prints OK/error per section together with
the raw values. The password is never printed and the account address is masked.

`npm run validate:translations` checks that `admin/i18n/<lang>.json` and `admin/jsonConfig.json`
stay in sync across all 11 languages.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 1.1.1 (2026-08-23)

- (cavernerg) **FIXED**: `water.yesterdayInactive` was never created — the flow summary and the watering report of a period were fetched in separate turns, so the leak share of a finished day could not be worked out
- (cavernerg) **FIXED**: a transient HTTP 429 or 5xx from the login endpoint was reported as wrong credentials and stopped the v2 polling until the next adapter restart
- (cavernerg) **FIXED**: a GraphQL endpoint answering 401 for good no longer triggers a fresh login on every poll — the adapter stops instead of hammering the account
- (cavernerg) **FIXED**: `info.connectionV2` stayed `true` while every single query failed; it now follows what the poll actually returned
- (cavernerg) **FIXED**: the leak indicator could fire on a run spanning midnight, or when the snapshot query failed while a zone was watering — it now needs two consecutive polls and knowledge of the running zones, and it is no longer created at all when the check is switched off
- (cavernerg) **FIXED**: a state created while nothing had flowed kept the fallback unit for the rest of the adapter run instead of taking the account's unit once the API reported one
- (cavernerg) **FIXED**: a flow summary in which every meter answers `null` no longer overwrites `water.week`/`month`/`year` with 0
- (cavernerg) **FIXED**: polls no longer overlap when one takes longer than the poll interval
- (cavernerg) **FIXED**: `subscribeStates` is registered only with a configured API key again (as upstream did), so a zone button without a key can no longer produce an unhandled rejection
- (cavernerg) **FIXED**: the poll interval warning compared the configured value instead of the clamped one that actually runs
- (cavernerg) **SECURITY**: the password grant no longer follows redirects — a 307/308 would have replayed the credentials to the redirect target — and `email` joins `password` in `protectedNative`
- (cavernerg) **ENHANCED**: `tools/check-v2.js` masks the account address, no longer prints the password length, finds the ioBroker CLI without a hardcoded path, and shares the adapter's own aggregation helpers instead of its own copies

### 1.1.0 (2026-08-23)

- (cavernerg) **NEW**: optional support for the Hydrawise v2 API (OAuth2 + GraphQL): water usage per day/week/month/year, consumption and runtime per zone, sensor states, controller details and rainfall
- (cavernerg) **NEW**: leak detection — `water.leakSuspected` is set when more water flowed today than the recorded watering runs explain
- (cavernerg) **FIXED**: axios errors were wrapped into a new `Error`, which dropped `response.status`, so the retry logic for HTTP 429 never triggered and `customer.*` stopped updating until the next adapter restart
- (cavernerg) **FIXED**: the rate limit branch of `buildRequest()` settled its promise neither with `resolve` nor `reject`, which made `onReady()` hang once that branch became reachable
- (cavernerg) **FIXED**: `last_contact` was parsed as an epoch value even when the API answers `"Unknown"`, leaving the state at `Invalid Date`
- (cavernerg) **FIXED**: no more "DB closed" errors in the log when the adapter shuts down
- (cavernerg) **ENHANCED**: `customerdetails.php` polls on its own interval (default 30 minutes) with a backoff after HTTP 429, and a rate limit no longer sets `info.connection` to false
- (cavernerg) **FIXED**: `lastErrorCode` was a local variable that reset on every request, so the "do not repeat the same error" suppression never took effect
- (cavernerg) **ENHANCED**: the adapter warns once when the API asks to be polled more often than the configured interval

Changelog of the original adapter: [upstream README](https://github.com/SentiQ/ioBroker.hydrawise#changelog)
and [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT, unchanged from the original — see [LICENSE](LICENSE).
Copyright (c) 2025-2026 SentiQ <yves.nuesser@proton.me>
