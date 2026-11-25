# 001: Server time endpoint and clock drift

## Problem

The web app and the API run on different machines (Vercel functions, a local
dev box). When their clocks disagree, timestamps in logs and responses do not
line up, and nobody notices until a bug depends on it. We have no way to see
the drift.

## Users

- The maintainer, who opens the home page to check that both services are
  healthy and in sync.
- Future features that need a trusted server time (expiry, scheduling).

## Acceptance criteria

1. `GET /time` on the API returns HTTP 200 with a JSON body `{ iso, epochMs }`.
2. `iso` is the ISO 8601 UTC string of the same instant as `epochMs`
   (`new Date(epochMs).toISOString() === iso`).
3. The payload is built by `buildTime(now: Date)` in `packages/shared`, and its
   type `TimeResponse` is exported from `@repo/shared`. The API does not build
   the payload by hand.
4. The web home page shows the clock drift between web and API in
   milliseconds, with a sign: positive means the API clock is ahead.
5. Drift is corrected for network latency: the API time is compared with the
   midpoint between the web's request start and response end.
6. When the API is unreachable, the home page still renders and shows
   `unreachable: <reason>` instead of a drift value.

## Edge cases

- `buildTime` gets an invalid `Date` (`new Date(NaN)`): it throws a
  `RangeError` rather than returning `NaN` or `"Invalid Date"`.
- The API answers with a body that is not a valid `TimeResponse` (missing
  fields, `epochMs` not a finite number): the page treats it as unreachable
  with a clear reason.
- Drift smaller than 1 ms is shown as `0 ms`; values are rounded to whole ms.
- `NEXT_PUBLIC_API_URL` is not set: same message as the existing health and
  version rows.

## Out of scope

- Correcting or syncing clocks (NTP). We only display the drift.
- Time zones and locale formatting: everything is UTC.
- Caching `/time`; it must never be cached.
- Alerts when drift exceeds a threshold.

## Risk

Low. Read-only endpoint with no auth, data or money involved. The shared
contract change touches both apps, so the shared task is the one to review
most carefully.
