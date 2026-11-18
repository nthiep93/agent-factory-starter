---
name: implement-task
description: Takes one small task from description to a pushed branch with tests, an independent review and verify evidence. Use for a single feature or fix that fits in one PR.
disable-model-invocation: true
---

Task: $ARGUMENTS

If the task above is empty, ask for it and stop.

1. **Restate.** Write the task as 2-5 acceptance criteria plus the edge cases you will test. If a criterion depends on a guess about intent, ask before writing code.
2. **Branch.** If the current branch is `main`, create `feat/<short-slug>` (or `fix/<short-slug>`). Inside a worktree, stay on its branch.
3. **Test first.** Add or extend `*.test.ts` files that encode the criteria. Run them and confirm they fail for the right reason.
4. **Implement** the smallest change that passes. Follow `AGENTS.md` and the path rules in `.claude/rules/`. Shared types go in `packages/shared`.
5. **Verify.** Run `pnpm verify`. Fix until it passes. Never weaken or delete a test to get there.
6. **Independent review.** Use the `reviewer` subagent. Give it the acceptance criteria and the output of `git diff main...HEAD` plus uncommitted changes. Fix every correctness gap it reports, then run `pnpm verify` again. If you disagree with a finding, say why in the final report instead of silently skipping it.
7. **Commit** with a message whose subject says what changed and whose body says why.
8. **Push** with `git push -u origin HEAD` only if the user allowed pushing in this session. Then print the compare link `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`, taking owner and repo from `git remote get-url origin`.

Final report, in this order: the acceptance criteria with pass/fail, reviewer findings and what you did about each, the last `pnpm verify` summary line, the branch and compare link. Keep it under 20 lines.
