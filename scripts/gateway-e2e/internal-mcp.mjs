import { DEVICE, ORG, USER } from './fixtures.mjs'

/** Runs against the suite's disposable database, never the developer's working instance. */
export async function checkInternalMcp(ctx, check, headers) {
  let id = 0
  const rpc = async (method, params = {}, extraHeaders = {}) => {
    const response = await fetch(`${ctx.gateway}/mcp`, {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    return response.json()
  }
  const call = (name, args = {}, extraHeaders) =>
    rpc('tools/call', { name: `hacknah_${name}`, arguments: args }, extraHeaders)
  const data = (res) => {
    if (res.error || res.result?.isError) throw new Error(JSON.stringify(res))
    return JSON.parse(res.result.content[0].text)
  }
  // Discovery cannot require or silently create an upstream MCP integration.
  await ctx.query('DELETE FROM mcp_server')
  await check(
    'members cannot discover or invoke platform tools',
    'Internal MCP authorization',
    async () => {
      const listed = await rpc('tools/list')
      const denied = await call('create_guardrail', { name: 'Should not exist' })
      return {
        ok: listed.result?.tools?.length === 0 && denied.result?.isError === true,
        listed,
        denied,
      }
    },
  )
  await ctx.query(
    `UPDATE member SET role='admin' WHERE organization_id='${ORG}' AND user_id='${USER}'`,
  )
  await check(
    'built-in tools initialize and list without an integration',
    'Internal MCP discovery',
    async () => {
      const init = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1' },
      })
      const listed = await rpc('tools/list')
      const stored = await ctx.query('SELECT count(*) AS n FROM mcp_server')
      return {
        ok:
          init.result?.serverInfo?.title === 'Hack?Nah!' &&
          listed.result?.tools?.some((t) => t.name === 'hacknah_create_guardrail') &&
          stored[0].n === 0,
        init,
        count: listed.result?.tools?.length,
      }
    },
  )
  await check(
    'mismatched fingerprints cannot invoke platform tools',
    'Internal MCP device binding',
    async () =>
      (await call('list_datasets', {}, { 'x-acl-device': 'not-the-enrolled-device' })).result
        ?.isError === true,
  )
  await check(
    'invalid arguments return an MCP tool error',
    'Internal MCP input validation',
    async () => (await call('create_guardrail', { name: '' })).result?.isError === true,
  )
  let guardrailId
  await check(
    'create, inspect, save and publish a guardrail through MCP',
    'Internal MCP actions',
    async () => {
      const made = data(await call('create_guardrail', { name: 'Internal MCP e2e guardrail' }))
      guardrailId = made.id
      const read = data(await call('get_guardrail', { guardrailId }))
      const graph = data(await call('guardrail_schema')).starter
      const draft = data(await call('save_guardrail_draft', { guardrailId, definition: graph }))
      const published = data(await call('publish_guardrail', { guardrailId, note: 'MCP e2e' }))
      const after = data(await call('get_guardrail', { guardrailId }))
      return {
        ok:
          read.draft?.status === 'draft' &&
          draft.version === published.version &&
          after.published?.version === published.version,
        made,
        published,
      }
    },
  )
  await check(
    'unknown and foreign guardrail IDs cannot be edited',
    'Internal MCP scope',
    async () =>
      (await call('update_guardrail', { guardrailId: 'not-in-this-instance', enabled: false }))
        .result?.isError === true,
  )
  await check(
    'foreign guardrail scope is rejected without mutation',
    'Internal MCP scope',
    async () => {
      await ctx.query(
        "INSERT INTO guardrail (id,org_id,name,enabled,position,group_ids,created_at,updated_at) VALUES ('wf_foreign','foreign','Foreign policy',1,0,'[]',0,0)",
      )
      const result = await call('update_guardrail', { guardrailId: 'wf_foreign', enabled: false })
      const [row] = await ctx.query("SELECT enabled FROM guardrail WHERE id='wf_foreign'")
      return result.result?.isError === true && row.enabled === 1
    },
  )
  await check(
    'unknown group scope cannot widen a guardrail to everyone',
    'Internal MCP scope',
    async () => {
      return (
        (await call('update_guardrail', { guardrailId, groupIds: ['foreign-group'] })).result
          ?.isError === true
      )
    },
  )
  await check(
    'policy export and preview do not change the current rule revision',
    'Internal MCP policy preview',
    async () => {
      const before = await ctx.query(`SELECT revision FROM analysis_revision WHERE org_id='${ORG}'`)
      const { yaml } = data(await call('export_policy'))
      const preview = data(await call('preview_policy', { yaml }))
      const after = await ctx.query(`SELECT revision FROM analysis_revision WHERE org_id='${ORG}'`)
      return {
        ok: preview.ok && !preview.applied && before[0].revision === after[0].revision,
        preview,
      }
    },
  )
  await check(
    'run, retrieve and invalidate persisted analysis through MCP',
    'Internal MCP attack analysis',
    async () => {
      // Keep the test guardrail from adding a production decision; the normal fixture policies remain.
      data(await call('update_guardrail', { guardrailId, enabled: false }))
      const run = data(await call('run_analysis', { datasetId: 'prompt-injection' }))
      const saved = data(await call('get_analysis_run', { id: run.id, limit: 2 }))
      const list = data(await call('list_analysis_runs'))
      data(
        await call('update_guardrail', {
          guardrailId,
          description: 'Invalidate the synthetic run',
        }),
      )
      const stale = await call('get_analysis_run', { id: run.id })
      return {
        ok:
          run.total === 2400 &&
          saved.items.length === 2 &&
          saved.nextOffset === 2 &&
          list.runs.some((r) => r.id === run.id) &&
          stale.result?.isError === true,
        run,
        savedCount: saved.items.length,
        stale,
      }
    },
  )
  await check(
    'platform actions have attributable audit records',
    'Internal MCP audit',
    async () => {
      const rows = await ctx.query(
        `SELECT actor_id, target FROM audit_log WHERE action='mcp.internal.success' AND target='hacknah_create_guardrail'`,
      )
      return rows.some((r) => r.actor_id === USER)
    },
  )
  await ctx.query(`UPDATE device SET status='revoked' WHERE id='${DEVICE}'`)
  await check(
    'revoking the device takes effect without waiting for cached gateway claims',
    'Internal MCP revocation',
    async () => {
      const res = await call('list_datasets')
      return res.result?.isError === true || Boolean(res.error)
    },
  )
  await ctx.query(`UPDATE device SET status='trusted' WHERE id='${DEVICE}'`)
  await ctx.query(
    `UPDATE member SET role='member' WHERE organization_id='${ORG}' AND user_id='${USER}'`,
  )
  await check(
    'removing admin rights takes effect on the next call',
    'Internal MCP role changes',
    async () => (await call('list_datasets')).result?.isError === true,
  )
}
