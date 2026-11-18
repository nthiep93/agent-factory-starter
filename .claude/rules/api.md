---
paths:
  - "apps/api/**/*.ts"
---

- One feature per folder under `src/`: `<feature>.controller.ts`, `<feature>.service.ts`, `<feature>.controller.test.ts`.
- Controllers only map HTTP to service calls. Business logic lives in services.
- Register every new controller and provider in a module, then cover it with a test that resolves it through `Test.createTestingModule` (see `src/health/health.controller.test.ts`).
- Relative imports end in `.js` (ESM, `nodenext`), for example `./health.service.js`.
- Response types shared with the web app come from `@repo/shared`.
