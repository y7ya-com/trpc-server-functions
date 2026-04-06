# Demo Client

Minimal Vite client for the `trpc-server-functions` demo.

## Run

From [`demo/`](/Users/y/Documents/GitHub/trpc-server-functions/demo):

```bash
pnpm dev
```

Client:
- `http://localhost:4317`

Server:
- `http://localhost:4318`

## What it demonstrates

- [`src/App.tsx`](/Users/y/Documents/GitHub/trpc-server-functions/demo/client/src/App.tsx): Minimal counter UI plus co-located `createServerFn()` query and mutation.
- [`src/server/db.ts`](/Users/y/Documents/GitHub/trpc-server-functions/demo/client/src/server/db.ts): Server-only module imported directly by the co-located handlers.
- [`vite.config.ts`](/Users/y/Documents/GitHub/trpc-server-functions/demo/client/vite.config.ts): Adds the `trpcServerFunctionsPlugin` from `trpc-server-functions/vite`.
