# Architecture

```
apps/web (Next.js)  --HTTP-->  apps/api (NestJS)
        \                         /
         +---- packages/shared ---+
```

- `packages/shared` holds contract types and pure functions. It is compiled to CommonJS in `dist/` and both apps import the compiled output.
- `apps/api` exposes REST endpoints. `GET /health` is the reference feature: controller, service and a DI-level test.
- `apps/web` renders pages with the App Router and keeps logic in `lib/`.

## Dependency direction

`shared` imports nothing from the apps. The apps never import from each other. Anything both need moves to `shared`.

## Adding a feature

1. Add or extend the contract type in `packages/shared/src`, with a test.
2. Add the feature folder in `apps/api/src/<feature>/` and register it in a module.
3. Consume it from `apps/web`.
4. Run `pnpm verify`.
