# 001: Plan

## Approach

Follow the `GET /version` feature as the template: contract and pure builder
in `packages/shared`, a thin controller and service in `apps/api`, a never-
throwing fetch helper and a pure formatter in `apps/web/lib`, wired into the
home page.

## Contract (packages/shared)

```ts
// packages/shared/src/time.ts
export interface TimeResponse {
  /** ISO 8601 in UTC, e.g. "2026-11-25T10:00:00.000Z". */
  iso: string;
  /** Milliseconds since the Unix epoch. */
  epochMs: number;
}

/** Throws RangeError for an invalid Date. */
export function buildTime(now: Date): TimeResponse;
```

Re-export both from `packages/shared/src/index.ts`.

## Files per app

| Area   | Files                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| shared | `src/time.ts`, `src/time.test.ts`, `src/index.ts` (export)                                                         |
| api    | `src/time/time.controller.ts`, `src/time/time.service.ts`, `src/time/time.controller.test.ts`, `src/app.module.ts` |
| web    | `lib/time.ts`, `lib/time.test.ts`, `lib/api.ts` (`fetchApiTime`), `app/page.tsx`                                   |

## API

- `TimeService.now()` returns `buildTime(new Date())`; the clock is injectable
  in tests (pass a `Date` factory) so the controller test is deterministic.
- `GET /time` sets `Cache-Control: no-store`.

## Web

- `measureDrift(startMs, endMs, api: TimeResponse)` in `lib/time.ts` returns
  `Math.round(api.epochMs - (startMs + endMs) / 2)`.
- `formatDrift(ms)` returns `"+12 ms"`, `"-3 ms"` or `"0 ms"`.
- `fetchApiTime` reuses the never-throwing `fetchApi` helper and validates the
  body shape; an invalid body becomes `{ reachable: false, reason }`.
- The home page measures `Date.now()` around the fetch and adds a
  "Clock drift" row.

## Order

1. Shared contract first: both apps depend on it.
2. API endpoint.
3. Web display, which needs the endpoint to exist to be useful.
