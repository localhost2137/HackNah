import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { adminMiddleware } from '../middleware.ts'
import { exportPolicyYaml, importPolicyYaml } from '../policy.ts'

export const exportPolicy = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context: { db, orgId } }) => exportPolicyYaml(db, orgId))

export const importPolicy = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      yaml: z.string().max(2_000_000),
      mode: z.enum(['replace', 'merge']).default('replace'),
      dryRun: z.boolean().default(true),
    }),
  )
  .handler(({ data, context: { db, orgId, user: me } }) =>
    importPolicyYaml(db, orgId, me.id, data.yaml, { mode: data.mode, dryRun: data.dryRun }),
  )
