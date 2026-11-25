# Agent guide

Turborepo monorepo, pnpm workspaces, Node 22, TypeScript strict.

## Commands

- Install: `pnpm install`
- Verify everything (run before saying a task is done): `pnpm verify`
- Lint only: `pnpm lint`
- Typecheck only: `pnpm typecheck`
- Test one package: `pnpm --filter api test` (also `web`, `@repo/shared`)
- Test one file: `pnpm --filter api exec vitest run src/health/health.controller.test.ts`
- Build: `pnpm build`
- Run locally: `pnpm dev` (ports come from `.worktree.env` inside a worktree, otherwise web 3000 / api 3001)

## Workflow

- `main` is protected. Work on a branch and open a PR; never push to `main`.
- Parallel work happens in worktrees under `.claude/worktrees/`, created with `pnpm wt new <name>`. Stay inside your worktree; do not edit files in another one.
- Before calling a task done, have the `reviewer` subagent check your diff against the task.

## Map

- `apps/api`: NestJS 12 backend. One folder per feature under `src/`.
- `apps/web`: Next.js 16 App Router. Pages in `app/`, pure helpers in `lib/`.
- `apps/orchestrator`: NestJS 12 service that turns labeled issues into agent runs (BullMQ + Claude Agent SDK). Not deployed to Vercel. See `docs/orchestrator.md`.
- `packages/shared`: types and pure functions used by both apps.
- `packages/factory`: tested logic for the factory itself: tasks.md parsing (`src/spec`), PR risk (`src/risk`), agent PR metrics (`src/metrics`). Scripts in `scripts/` load its `dist/`.
- `specs/`: feature specs written with `/write-spec` (spec.md, plan.md, tasks.md). See `docs/spec-workflow.md`.
- `docs/`: architecture and conventions. Read the relevant file before a non-trivial change.
- `holdout/`: acceptance scenarios. Off limits, you cannot read or edit them.

## Conventions

- Types and logic used by both apps go in `packages/shared`, never duplicated.
- Every behaviour change ships with a test in the same PR. Test files sit next to the code as `*.test.ts`.
- No `any`, no `console.log` (lint fails). Use `console.warn` / `console.error` or the Nest `Logger`.
- Never weaken or delete a test to make it pass. If a test looks wrong, stop and say so.

## Gotchas

- Apps import `@repo/shared` from its `dist/`. After changing it, run `pnpm build --filter @repo/shared` (the `typecheck` and `test` tasks do this for you through turbo).
- `apps/api` is ESM (`"type": "module"`, `nodenext`) because NestJS 12 ships ESM only. Relative imports need the `.js` extension: `import { X } from "./x.service.js"`. Vercel's runtime cannot `require()` ESM, so a CommonJS build fails there even when it runs locally.
- API tests run through SWC (`apps/api/vitest.config.mts`) because Nest DI needs decorator metadata. Do not remove the plugin.
- `apps/web/next-env.d.ts` is generated and gitignored; `pnpm typecheck` regenerates it with `next typegen`. `apps/web/AGENTS.md` is written by `next dev`; keep it committed.
- In GitHub Actions the `Stop` typecheck hook is skipped (it would run PR-controlled scripts with secrets in the environment). There, run `pnpm verify` yourself before finishing; the CI `verify` job is the gate.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support 7 yet. Do not bump it.

## Done means

`pnpm verify` passes, and the final message includes the command and its output as evidence.
