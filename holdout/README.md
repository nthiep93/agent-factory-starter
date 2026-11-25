# Holdout scenarios

End-to-end acceptance scenarios that coding agents must not see or edit. They exist so an agent cannot pass by tuning code to the tests.

## Who can see and change them

- Agents are denied `Read` and `Edit` here in `.claude/settings.json`, the `protect-files.sh` hook blocks writes, and `claude.yml` passes `--disallowedTools` for `holdout/**`.
- The folder is not part of the pnpm workspace and `pnpm verify` never runs it, so a builder running verify sees nothing from here.
- Changes need a human: `CODEOWNERS` requires the owner's review, and the `PR risk` workflow labels any change under `holdout/` as `risk:high`, which is never auto-merged.

## What is covered

| File                    | Scenario                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `api.test.mjs`          | `GET /health` shape and `status: "ok"`                                                |
|                         | `GET /version` shape, `service: "api"`, `commit` / `branch` string or null            |
|                         | unknown route returns 404 JSON                                                        |
|                         | CORS: `access-control-allow-origin` on `/health`                                      |
| `web.test.mjs`          | home page is 200 HTML with `web: ok`, `api: ok` and the "Phiên bản đang chạy" section |
| `web-api-down.test.mjs` | home page still renders with `api: unreachable: <reason>` when its API is down        |
| `helpers.mjs`           | shared helpers (not a test)                                                           |

Scenarios use only Node 22 built-ins (`node:test`, `fetch`), no dependencies.

## Running

Environment: `API_URL` and `WEB_URL` (required), `WEB_DEAD_API_URL` (a web server whose `NEXT_PUBLIC_API_URL` points at a port with nothing listening; the scenario is reported as skipped when unset).

```bash
pnpm build
PORT=3001 node apps/api/dist/main.js &
NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm --filter web exec next start --port 3000 &
NEXT_PUBLIC_API_URL=http://localhost:3009 pnpm --filter web exec next start --port 3002 &
API_URL=http://localhost:3001 WEB_URL=http://localhost:3000 WEB_DEAD_API_URL=http://localhost:3002 \
  node --test 'holdout/*.test.mjs'
```

Keep the glob quoted: Node expands it, and Node 22 does not accept a directory (`node --test holdout/`). In CI the `holdout` job in `.github/workflows/ci.yml` does exactly this.
