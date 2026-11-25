---
name: write-spec
description: Turns a larger feature into specs/<NNN>-<slug>/ (spec.md, plan.md, tasks.md) whose tasks are small, ordered, agent-ready GitHub issues. Use before implementing anything that needs more than one PR.
disable-model-invocation: true
---

Feature: $ARGUMENTS

If the feature above is empty, ask for it and stop.

You write the spec only. Do not change application code, and never run `spec-to-issues.mjs --create`: creating issues and adding the `agent` label is the human's decision.

1. **Read first.** `AGENTS.md`, `docs/architecture.md`, `docs/spec-workflow.md`, and the code the feature touches (closest existing feature as a template, e.g. `apps/api/src/version/`). Look at `specs/` for earlier specs.
2. **Interview briefly.** Ask at most 5 questions in a single message, only about what you cannot infer from the code: who uses it, what "done" looks like, limits (performance, data, security), what is explicitly out of scope, risk. Offer your best-guess answer with each question so the human can reply "ok". Wait for the answers. If the human says "just go", proceed with your guesses and list them under "Assumptions" in spec.md.
3. **Pick the folder.** `specs/<NNN>-<slug>/`: `NNN` is the highest existing number plus one, zero-padded to 3 digits (`001` if `specs/` is empty); `slug` is 2-5 lowercase kebab-case words.
4. **Write `spec.md`** with these sections: `# <NNN>: <title>`, `## Problem`, `## Users`, `## Acceptance criteria` (numbered, each one checkable by a test or a single observation), `## Edge cases`, `## Out of scope`, `## Risk` (low, medium or high, with one sentence why). Add `## Assumptions` if you guessed anything.
5. **Write `plan.md`**: `## Approach` (which existing feature it follows), `## Contract (packages/shared)` with the exact TypeScript types and function signatures both apps share (they live in `packages/shared`, never duplicated), `## Files per app` (a table: area, files), then any API or data notes and the `## Order` of work with the reason.
6. **Write `tasks.md`** in exactly this format. The validator rejects anything else.

   ```markdown
   # Tasks: <NNN> <title>

   ## T1: Add TimeResponse and buildTime to packages/shared

   goal: One or two sentences: what changes and why.
   area: shared
   risk: low
   depends: none
   in-scope: packages/shared/src/time.ts and its export
   out-of-scope: apps/api, apps/web
   Acceptance:

   - buildTime(new Date(0)) returns { iso: "1970-01-01T00:00:00.000Z", epochMs: 0 }
   - buildTime(new Date(NaN)) throws a RangeError

   ## T2: Expose GET /time in the API

   goal: ...
   area: api
   risk: low
   depends: T1
   Acceptance:

   - GET /time returns 200 with { iso, epochMs }
   ```

   Rules:
   - One `## T<n>: <title>` heading per task. Ids are `T` plus a number and unique. The title becomes the issue title after `[agent] `.
   - Required keys: `goal`, `area` (`api` | `web` | `shared` | `docs` | `infra`), `risk` (`low` | `medium` | `high`), `depends` (`none` or a comma list like `T1, T2`). Optional: `in-scope`, `out-of-scope`. Keys are one line each; no other keys.
   - `Acceptance:` on its own line, then one `- ` bullet per criterion (at least one). Indent a line by two spaces to continue the previous bullet.
   - Never write `@claude` anywhere in tasks.md: `claude.yml` starts the agent when a new issue mentions it, bypassing the risk and dependency labels, so the validator rejects it.
   - Text before the first `##` heading is ignored. Inside a task, only keys, bullets and blank lines are allowed. Blank lines are fine anywhere (Prettier adds some after headings and `Acceptance:`).

   Sizing and ordering:
   - Each task is one PR that one agent run can finish: usually one area, at most about 5 acceptance criteria, no "and also" goals. Split anything bigger.
   - Shared contracts first (`area: shared`), then `api`, then `web`. Every task lists the tasks whose code it needs in `depends`; no cycles.
   - Each acceptance bullet must be checkable by a test the agent writes. Copy concrete values (inputs, outputs, status codes) from the spec rather than restating it vaguely.
   - `risk: high` for auth, data migrations, money, security or anything irreversible. High-risk tasks never get the `agent` label or any automatic path to it; a human implements them or dispatches them explicitly.
   - Labels follow from the task: no `depends` and low/medium risk gets `agent` (starts immediately); with `depends` it gets `waiting-on-deps`, and the unblock-tasks workflow swaps that for `ready-for-agent` once every dependency issue is closed, so a human can add `agent`. Only list a dependency when the task really needs that code merged first; unnecessary dependencies delay dispatch.
   - Together, the tasks must cover every acceptance criterion in spec.md. Leave nothing to a "final cleanup" task.

7. **Validate.** Run `pnpm build --filter @repo/factory`, then `node scripts/spec-to-issues.mjs specs/<NNN>-<slug>` (dry run). Fix every reported line in `tasks.md` and run again until it exits 0. Read the printed issues once as if you were the agent: if one could not be done from its body plus spec.md and plan.md, rewrite it.
8. **Hand over.** Do not commit unless asked. Report in under 15 lines: the folder, the task order with risk and dependencies (`T1 (low) -> T2 (low, after T1)`), assumptions the human should check, and the next command for the human: `node scripts/spec-to-issues.mjs specs/<NNN>-<slug> --create`.
