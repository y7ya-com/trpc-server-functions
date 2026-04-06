import { trpcServerFunctions } from './generated/trpc-server-functions'

import { router } from './trpc'

export const appRouter = router({
  ...(trpcServerFunctions() as Record<string, never>),
})

export type AppRouter = typeof appRouter
