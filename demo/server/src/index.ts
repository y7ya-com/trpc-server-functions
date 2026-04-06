import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'

import { appRouter } from './router'

const app = new Hono()
const middleware = trpcServer({
  endpoint: '/api/trpc',
  router: appRouter,
})

app.use('/api/trpc/*', (c, next) => middleware(c, next))

serve(
  {
    fetch: app.fetch,
    port: 4318,
  },
  () => {
    console.log('Server running at http://localhost:4318')
  },
)
