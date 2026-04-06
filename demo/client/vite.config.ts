import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

import { trpcServerFunctionsPlugin } from 'trpc-server-functions/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const demoRoot = path.resolve(__dirname, '..')
const serverRoot = path.resolve(demoRoot, 'server')

export default defineConfig({
  plugins: [
    react(),
    trpcServerFunctionsPlugin({
      procedure: {
        importPath: path.resolve(serverRoot, 'src/trpc.ts'),
        exportName: 'publicProcedure',
      },
      generatedModulePath: '../server/src/generated/trpc-server-functions.ts',
    }) as unknown as PluginOption,
  ],
  server: {
    port: 4317,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4318',
    },
    fs: {
      allow: [path.resolve(__dirname, '../..'), demoRoot],
    },
  },
})
