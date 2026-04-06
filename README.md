# tRPC Server Functions

`trpc-server-functions` brings co-located server functions to `tRPC` + Vite apps.

Define a server function anywhere in your frontend, and generate matching `tRPC` procedures for your backend router.

## Expected Structure

This package is designed for a split setup: a Vite client app and a separate server app.

```text
your-app/
  client/
    src/
      App.tsx
      main.tsx
    vite.config.ts
  server/
    src/
      db.ts
      trpc.ts
      router.ts
      generated/
        trpc-server-functions.ts
```

The generated file is written by the client-side Vite plugin or by the CLI on first setup.

## 1-File Counter Example

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { db } from "../../server/src/db";
import { createServerFn } from "trpc-server-functions";

export const getCount = createServerFn().query(async () => {
  return db.getCount();
});

export const incrementCount = createServerFn().mutation(async () => {
  return db.increment();
});

export function Counter() {
  const queryClient = useQueryClient();
  const countQuery = useQuery(getCount.queryOptions());
  const incrementMutation = useMutation({
    ...incrementCount.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getCount.queryOptions().queryKey,
      });
    },
  });

  return (
    <main>
      <h1>Counter</h1>
      <p>{countQuery.data ?? "..."}</p>
      <button
        type="button"
        disabled={incrementMutation.isPending}
        onClick={() => incrementMutation.mutate(undefined)}
      >
        {incrementMutation.isPending ? "Incrementing..." : "Increment"}
      </button>
    </main>
  );
}
```

At build time:

- the client keeps typed RPC proxies
- the real handlers are removed from the browser bundle
- a generated server module turns these exports into normal `tRPC` procedures

## Setup

Install the package:

```bash
npm install trpc-server-functions
```

### 1. Add the Vite plugin

```ts
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { trpcServerFunctionsPlugin } from "trpc-server-functions/vite";

export default defineConfig({
  plugins: [
    react(),
    trpcServerFunctionsPlugin({
      procedure: {
        importPath: path.resolve("../server/src/trpc.ts"),
        exportName: "publicProcedure",
      },
      generatedModulePath: "../server/src/generated/trpc-server-functions.ts",
    }),
  ],
});
```

### 2. Generate the server module once

```bash
trpc-server-functions generate \
  --root ./client \
  --generated-module-path ../server/src/generated/trpc-server-functions.ts \
  --procedure-import-path ../server/src/trpc.ts \
  --procedure-export-name publicProcedure
```

### 3. Use the generated module in the server router

```ts
import { trpcServerFunctions } from "./generated/trpc-server-functions";

import { router } from "./trpc";

export const appRouter = router({
  ...trpcServerFunctions(),
});
```

### 4. Connect the client transport

```ts
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import {
  createTRPCClientTransport,
  setServerFnTransport,
} from "trpc-server-functions";

const trpcClient = createTRPCUntypedClient({
  links: [httpBatchLink({ url: "/api/trpc" })],
});

setServerFnTransport(createTRPCClientTransport(trpcClient));
```

After that, `queryOptions()`, `mutationOptions()`, and `call()` use your existing `tRPC` endpoint.
