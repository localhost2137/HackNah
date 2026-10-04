import { type GatewayEvent, randomId } from '@acl/shared'
import { ZodError } from 'zod'
import { audit } from '../../server/audit.ts'
import { type AppContext, clientInfo } from '../context.ts'
import { userGroupIds } from '../lib/access.ts'
import { recordEvent } from '../lib/events.ts'
import { checkLimits } from '../lib/limits.ts'
import { invalidateModelCache } from '../lib/models.ts'
import { runPipeline } from '../lib/pipeline.ts'
import type { ResolvedSession } from '../lib/session.ts'
import { invalidatePolicyCaches, loadLimits } from '../lib/workflow.ts'
import { canManagePlatform } from './access.ts'
import { findInternalTool, internalTools } from './tools.ts'

const errorResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: true,
})

export async function listInternalTools(c: AppContext) {
  return (await canManagePlatform(c.get('db'), c.get('principal')))
    ? internalTools.map((tool) => tool.definition)
    : []
}

export async function callInternalTool(
  c: AppContext,
  session: ResolvedSession,
  name: string,
  args: unknown,
) {
  const db = c.get('db')
  const principal = c.get('principal')
  if (!(await canManagePlatform(db, principal)))
    return errorResult(
      'Platform tools require a current admin membership and a trusted, matching device.',
    )
  const tool = findInternalTool(name)
  if (!tool) return errorResult(`Unknown platform tool: ${name}`)
  const started = Date.now()
  const callId = randomId('evt')
  const entry: GatewayEvent = {
    id: callId,
    orgId: principal.orgId,
    userId: principal.userId,
    deviceId: principal.deviceId,
    sessionId: session.id,
    kind: 'tool_call',
    model: null,
    mcpServerId: null,
    toolName: name,
    resourceIds: [],
    decision: 'allow',
    checks: [],
    riskScore: 0,
    workflows: [],
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    upstreamStatus: null,
    ...clientInfo(c),
    payloadKey: null,
    createdAt: new Date(started).toISOString(),
  }
  // A durable attempt record must exist before an action can execute. Avoid copying policy/log
  // contents (which may contain secrets) into the audit log or a second R2 payload.
  await audit(db, {
    orgId: principal.orgId,
    actorId: principal.userId,
    action: 'mcp.internal.started',
    target: name,
    data: { callId, readOnly: tool.readOnly },
  })
  let release = async () => {}
  let outcome = 'error'
  try {
    const limits = await checkLimits(
      c.env,
      await loadLimits(db, principal.orgId),
      { scope: 'tool', toolName: name, mcpServerId: null, resourceIds: [] },
      {
        orgId: principal.orgId,
        userId: principal.userId,
        groupIds: await userGroupIds(db, principal),
      },
      { concurrency: true },
    )
    release = limits.release
    entry.checks = limits.checks
    if (limits.blocked) {
      entry.decision = 'rate_limited'
      outcome = 'blocked'
      return errorResult(limits.blocked.reason)
    }
    const policy = await runPipeline(
      c.env,
      db,
      principal,
      {
        kind: 'tool_call',
        // Configuration may describe attacks (e.g. keywords a rule blocks). It is not
        // model/tool traffic. Evaluate the management action, retaining structured
        // arguments for any explicit argument-rule checks on hacknah_* tools.
        text: `Hack?Nah! platform action: ${name}`,
        toolName: name,
        mcpServerId: null,
        resourceIds: [],
        toolTier: tool.readOnly ? 'read' : 'write',
        toolArguments: args,
      },
      {
        eventId: callId,
        sessionId: session.id,
        summary: `Hack?Nah! platform action: ${name}`,
        limits: limits.states,
      },
    )
    entry.checks = [...entry.checks, ...policy.checks]
    entry.decision = policy.decision
    entry.riskScore = policy.riskScore
    entry.workflows = policy.workflows
    if (policy.decision === 'block' || policy.decision === 'declined') {
      outcome = 'blocked'
      return errorResult(`Blocked by Hack?Nah!: ${policy.reasons.join('; ')}`)
    }
    // An approval may have taken minutes: recheck role and revocation just before execution.
    if (!(await canManagePlatform(db, principal))) {
      entry.decision = 'block'
      outcome = 'blocked'
      return errorResult('Admin access or trusted device status changed. Sign in again.')
    }
    const result = await tool.invoke(args, {
      db,
      orgId: principal.orgId,
      user: { id: principal.userId },
      env: c.env,
    })
    const failed =
      typeof result === 'object' && result !== null && 'ok' in result && result.ok === false
    outcome = failed ? 'error' : 'success'
    entry.upstreamStatus = failed ? 422 : 200
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: failed }
  } catch (error) {
    entry.upstreamStatus = 422
    if (error instanceof ZodError)
      return errorResult(
        `Invalid arguments: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      )
    return errorResult(error instanceof Error ? error.message : 'Platform action failed')
  } finally {
    if (!tool.readOnly) {
      invalidatePolicyCaches(principal.orgId)
      invalidateModelCache(principal.orgId)
    }
    await release()
    entry.latencyMs = Date.now() - started
    await audit(db, {
      orgId: principal.orgId,
      actorId: principal.userId,
      action: `mcp.internal.${outcome}`,
      target: name,
      data: { callId, durationMs: entry.latencyMs },
    })
    c.executionCtx.waitUntil(recordEvent(c.env, entry, null))
  }
}
