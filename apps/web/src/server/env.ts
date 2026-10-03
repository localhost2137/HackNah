import { env } from 'cloudflare:workers'
import { createDb, type Db } from '@acl/db'

export { env }

export function getDb(): Db {
  return createDb(env.DB)
}
