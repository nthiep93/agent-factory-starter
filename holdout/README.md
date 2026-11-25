# Holdout scenarios

End-to-end acceptance scenarios that coding agents must not see or edit. They exist so an agent cannot pass by tuning code to the tests.

## Who can see and change them

- Agents are denied `Read` and `Edit` here in `.claude/settings.json`, the `protect-files.sh` hook blocks writes, and `claude.yml` passes `--disallowedTools` for `holdout/**`.
- The folder is not part of the pnpm workspace and is in eslint's ignores and `.prettierignore`, so `pnpm verify` and `pnpm format` never run, print or touch it. CI lints it only inside the `holdout` job (`eslint --no-ignore holdout/`).
- On a PR, CI replaces `holdout/` with the copy from the PR's base commit before running it, so a PR cannot weaken the scenarios it is judged by. A change here only takes effect once a human has merged it.
- The `PR risk` workflow labels any change under `holdout/` as `risk:high`, which is never auto-merged, so a human must merge it. (`CODEOWNERS` lists this folder, but in a one-person repo without "Require review from Code Owners" it enforces nothing.)

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

Environment: `API_URL` and `WEB_URL` (required), `WEB_DEAD_API_URL` (a web server whose `API_URL` points at a port with nothing listening; skipped when unset, but a failure when the `CI` env var is set).

```bash
pnpm build
PORT=3001 node apps/api/dist/main.js &
API_URL=http://localhost:3001 pnpm --filter web exec next start --port 3000 &
API_URL=http://localhost:3009 pnpm --filter web exec next start --port 3002 &
API_URL=http://localhost:3001 WEB_URL=http://localhost:3000 WEB_DEAD_API_URL=http://localhost:3002 \
  node --test 'holdout/*.test.mjs'
```

The web servers take the API from the run-time `API_URL` variable: `NEXT_PUBLIC_API_URL` is inlined by `next build` when it is set at build time, so it cannot be changed at `next start`.

Keep the glob quoted: Node expands it, and Node 22 does not accept a directory (`node --test holdout/`). In CI the `holdout` job in `.github/workflows/ci.yml` does exactly this.
