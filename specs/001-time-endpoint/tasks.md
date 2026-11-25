# Tasks: 001 server time endpoint and clock drift

## T1: Add TimeResponse and buildTime to packages/shared

goal: Give the API and the web app one definition of the server time payload, so neither builds it by hand.
area: shared
risk: low
depends: none
in-scope: packages/shared/src/time.ts, its test, and the export in src/index.ts
out-of-scope: apps/api and apps/web (later tasks use the function)
Acceptance:

- buildTime(new Date(0)) returns { iso: "1970-01-01T00:00:00.000Z", epochMs: 0 }
- For any valid Date d, new Date(buildTime(d).epochMs).toISOString() equals buildTime(d).iso
- buildTime(new Date(NaN)) throws a RangeError
- TimeResponse and buildTime are exported from @repo/shared

## T2: Expose GET /time in the API

goal: Serve the current server time so clients can compare clocks with the API.
area: api
risk: low
depends: T1
in-scope: apps/api/src/time/ (controller, service, test) and registration in app.module.ts
out-of-scope: packages/shared (use buildTime as is), apps/web
Acceptance:

- GET /time returns 200 with a body equal to buildTime(now) for an injected clock
- The response has the header Cache-Control: no-store
- The controller test resolves the controller through Test.createTestingModule

## T3: Show web/API clock drift on the home page

goal: Let the maintainer see at a glance how far the API clock is from the web clock.
area: web
risk: low
depends: T1, T2
in-scope: apps/web/lib/time.ts, apps/web/lib/api.ts (fetchApiTime), apps/web/app/page.tsx
out-of-scope: apps/api, packages/shared, any clock correction
Acceptance:

- measureDrift(1000, 1100, { iso, epochMs: 1080 }) returns 30 (API compared with the request midpoint)
- formatDrift returns "+12 ms", "-3 ms" and "0 ms" for 12, -3 and 0.4
- fetchApiTime returns { reachable: false } with a reason when the body is not a valid TimeResponse
- The home page shows a "Clock drift" row, or "unreachable: <reason>" when the API cannot be reached
