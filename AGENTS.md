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

## Map

- `apps/api`: NestJS 12 backend. One folder per feature under `src/`.
- `apps/web`: Next.js 16 App Router. Pages in `app/`, pure helpers in `lib/`.
- `packages/shared`: types and pure functions used by both apps.
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
- TypeScript is pinned to 6.0.x because typescript-eslint does not support 7 yet. Do not bump it.

## Done means

`pnpm verify` passes, and the final message includes the command and its output as evidence.
