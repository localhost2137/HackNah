import { createFileRoute } from '@tanstack/react-router'
import { exportPolicyYaml, importPolicyYaml } from '#/server/policy.ts'
import { requestAdmin } from '#/server/request-admin.ts'

/**
 * The policy file over HTTP, for `pnpm policy:export` and `pnpm policy:apply`.
 * GET returns the YAML. POST takes the YAML as the body, `?mode=merge` to keep what the file
 * leaves out, `?dryRun=1` to only preview, and answers with the changes or the errors.
 */
export const Route = createFileRoute('/api/policy')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const who = await requestAdmin(request)
        if (!who) return Response.json({ error: 'Admins only' }, { status: 403 })
        return new Response(await exportPolicyYaml(who.db, who.orgId), {
          headers: {
            'content-type': 'application/yaml; charset=utf-8',
            'content-disposition': 'attachment; filename="acl-policy.yaml"',
          },
        })
      },
      POST: async ({ request }) => {
        const who = await requestAdmin(request)
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
