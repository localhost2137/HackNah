import { member } from '@acl/db'
import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'
import { createAuth } from '#/server/auth.ts'
import { getDb } from '#/server/env.ts'
import { getInstanceId } from '#/server/instance.ts'
import { exportPolicyYaml, importPolicyYaml } from '#/server/policy.ts'

/** The signed-in admin, from the session cookie; null for anyone else. */
async function admin(request: Request) {
  const db = getDb()
  const session = await createAuth(db).api.getSession({ headers: request.headers })
  if (!session) return null
  const orgId = await getInstanceId(db)
  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
  })
  return membership?.role === 'admin' ? { db, orgId, userId: session.user.id } : null
}

/**
 * The policy file over HTTP, for `pnpm policy:export` and `pnpm policy:apply`.
 * GET returns the YAML. POST takes the YAML as the body, `?mode=merge` to keep what the file
 * leaves out, `?dryRun=1` to only preview, and answers with the changes or the errors.
 */
export const Route = createFileRoute('/api/policy')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const who = await admin(request)
        if (!who) return Response.json({ error: 'Admins only' }, { status: 403 })
        return new Response(await exportPolicyYaml(who.db, who.orgId), {
          headers: {
            'content-type': 'application/yaml; charset=utf-8',
            'content-disposition': 'attachment; filename="acl-policy.yaml"',
          },
        })
      },
      POST: async ({ request }) => {
        const who = await admin(request)
        if (!who) return Response.json({ error: 'Admins only' }, { status: 403 })
        const url = new URL(request.url)
        const yaml = await request.text()
        const result = await importPolicyYaml(who.db, who.orgId, who.userId, yaml, {
          mode: url.searchParams.get('mode') === 'merge' ? 'merge' : 'replace',
          dryRun: ['1', 'true'].includes(url.searchParams.get('dryRun') ?? ''),
        })
        return Response.json(result, { status: result.ok ? 200 : 422 })
      },
    },
  },
})
