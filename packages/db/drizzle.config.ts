import { defineConfig } from 'drizzle-kit'

// Only generates SQL. Migrations are applied with `wrangler d1 migrations apply` (see apps/web).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
})
