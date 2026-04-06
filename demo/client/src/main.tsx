import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCUntypedClient, httpBatchLink } from '@trpc/client'

import {
  createTRPCClientTransport,
  setServerFnTransport,
} from 'trpc-server-functions/runtime'
import App from './App.tsx'

const queryClient = new QueryClient()
const trpcClient = createTRPCUntypedClient({
  links: [httpBatchLink({ url: '/api/trpc' })],
})

setServerFnTransport(createTRPCClientTransport(trpcClient))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
