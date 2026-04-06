# tRPC Server Functions

`trpc-server-functions` brings co-located server functions to `tRPC` + Vite apps. Define a server function anywhere in your frontend, and the matching `tRPC` procedures are generated automatically for your backend router.

## Usage

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { db } from "../../server/src/db";
import { createServerFn } from "trpc-server-functions/runtime";

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

The client build strips the handlers and keeps only typed RPC proxies. The server imports a generated module that turns these exports into real tRPC procedures.

## Setup

Install the package:

```bash
npm install trpc-server-functions
```

Add the Vite plugin in the client:

```ts
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { trpcServerFunctionsPlugin } from "trpc-server-functions";

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

Use the generated module in the server router:

```ts
import { trpcServerFunctions } from "./generated/trpc-server-functions";

import { router } from "./trpc";

export const appRouter = router({
  ...trpcServerFunctions(),
});
```

Connect the client transport:

```ts
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import {
  createTRPCClientTransport,
  setServerFnTransport,
} from "trpc-server-functions/runtime";

const trpcClient = createTRPCUntypedClient({
  links: [httpBatchLink({ url: "/api/trpc" })],
});

setServerFnTransport(createTRPCClientTransport(trpcClient));
```

If your server can start before Vite writes the generated file, pre-generate it:

```bash
trpc-server-functions generate \
  --root ./client \
  --generated-module-path ../server/src/generated/trpc-server-functions.ts \
  --procedure-import-path ../server/src/trpc.ts \
  --procedure-export-name publicProcedure
```
