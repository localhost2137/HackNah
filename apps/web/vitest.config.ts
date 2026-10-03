import { defineConfig } from 'vitest/config'

// Unit tests only cover pure modules, so they run in Node without the Cloudflare Vite plugin.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ['src/**/*.test.ts'] },
})
