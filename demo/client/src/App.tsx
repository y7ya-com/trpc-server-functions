import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { db } from '../../server/src/db'
import { createServerFn } from 'trpc-server-functions'

export const getCount = createServerFn().query(async () => {
  return db.getCount()
})

export const incrementCount = createServerFn().mutation(async () => {
  return db.increment()
})

function App() {
  const queryClient = useQueryClient()
  const countQuery = useQuery(getCount.queryOptions())
  const incrementMutation = useMutation({
    ...incrementCount.mutationOptions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getCount.queryOptions().queryKey,
      })
    },
  })

  return (
    <main>
      <h1>Counter</h1>
      <p>{countQuery.data ?? '...'}</p>
      <button disabled={incrementMutation.isPending} onClick={() => incrementMutation.mutate(undefined)} type="button">
        {incrementMutation.isPending ? 'Incrementing...' : 'Increment'}
      </button>
    </main>
  )
}

export default App
