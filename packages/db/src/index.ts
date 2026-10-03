import { type AnyD1Database, drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export * from './schema.ts'
export { schema }

/** Creates a Drizzle client over the D1 binding. Cheap enough to do per request. */
export function createDb(d1: AnyD1Database) {
  return drizzle(d1, { schema, casing: 'snake_case' })
}

export type Db = ReturnType<typeof createDb>

/** D1 caps bound parameters at 100 per statement; multi-row inserts have to be split. */
export const D1_MAX_PARAMS = 100

export function chunkRows<T>(rows: T[], columnsPerRow: number): T[][] {
  const size = Math.max(1, Math.floor(D1_MAX_PARAMS / columnsPerRow))
  const chunks: T[][] = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}
