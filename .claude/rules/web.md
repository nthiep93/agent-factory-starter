---
paths:
  - "apps/web/**/*.ts"
  - "apps/web/**/*.tsx"
---

- App Router only. Components are Server Components unless they need state or browser APIs, then add `"use client"` at the top.
- Put logic in pure functions under `lib/` with a `*.test.ts` next to them. Keep components thin.
- Import with the `@/` alias, not long relative paths.
- Read the API base URL from `process.env.NEXT_PUBLIC_API_URL`. Never hard-code hosts.
