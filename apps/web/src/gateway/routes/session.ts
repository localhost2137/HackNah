import {
  AGENT_TOOLS,
  type EventKind,
  type GatewayEvent,
  RedactionVault,
  randomId,
} from '@acl/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { type AppEnv, clientInfo } from '../context.ts'
import { sessionStub } from '../do/session.ts'
import { accessibleResources, userGroupIds } from '../lib/access.ts'
import { requireGatewayToken } from '../lib/auth.ts'
import { recordEvent } from '../lib/events.ts'
import { checkLimits } from '../lib/limits.ts'
import { runPipeline } from '../lib/pipeline.ts'
import { resolveSession } from '../lib/session.ts'
import { recallVerdict, rememberVerdict } from '../lib/verdicts.ts'
import { loadLimits } from '../lib/workflow.ts'

/** Tools exposed by our own MCP aggregator are checked there, not in the hook. */
const AGGREGATOR_TOOL_PREFIX = 'mcp__acl__'

const inspectInput = z.object({
  session_id: z.string().optional(),
  /** The agent sending the message and the one receiving it, for the audit trail. */
  from: z.string().max(120).default('agent'),
  to: z.string().max(120).default('agent'),
  text: z.string().max(400_000),
})

const hookInput = z.object({
  session_id: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.unknown(),
})

/** Endpoints used by the Claude Code plugin. */
export const pluginApi = new Hono<AppEnv>()
  .use('*', requireGatewayToken())
  .get('/resources', async (c) => {
    const resources = await accessibleResources(c.get('db'), c.get('principal'))
    return c.json({
      resources: resources.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    })
  })
  .get('/session', async (c) => {
    const session = await resolveSession(c)
    if ('error' in session) return c.json({ error: session.error }, 403)
    return c.json({ session })
  })
  /** `/acl resources` in Claude Code: limit what this session may touch. */
  .put('/session/resources', async (c) => {
    const body = z
      .object({ resourceIds: z.array(z.string()).max(200) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const session = await resolveSession(c)
    if ('error' in session) return c.json({ error: session.error }, 403)
    if (!session.id) return c.json({ error: 'Missing session id header' }, 400)

    const principal = c.get('principal')
    const allowed = new Set((await accessibleResources(c.get('db'), principal)).map((r) => r.id))
    const denied = body.data.resourceIds.filter((id) => !allowed.has(id))
    if (denied.length) return c.json({ error: 'Not permitted', denied }, 403)
    const state = await sessionStub(c.env, principal.orgId, session.id).setResources(
      body.data.resourceIds,
    )
    return c.json({ session: { id: session.id, state } })
  })
  /**
   * Claude Code PreToolUse hook for built-in tools (Bash, Edit, WebFetch, ...). Responds in the
   * hook output format so the plugin can pipe it straight back to Claude Code.
   */
  .post('/hooks/pre-tool-use', async (c) => {
    const started = Date.now()
    const body = hookInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    if (body.data.tool_name.startsWith(AGGREGATOR_TOOL_PREFIX)) return c.json(hookDecision('allow'))

    const session = await resolveSession(c, body.data.session_id ?? null)
    if ('error' in session) return c.json(hookDecision('deny', session.error))

    const principal = c.get('principal')
    const db = c.get('db')
    const { tool_name: toolName, tool_input: toolInput } = body.data
    const deny = (reasons: string[]) =>
      c.json(hookDecision('deny', `Hack?Nah!: ${reasons.join('; ') || 'blocked'}`))

    // The output guard usually checked this exact call already, while the model wrote it.
    const cached = await recallVerdict(c.env, principal.orgId, session.id, toolName, toolInput)
    if (cached)
      return cached.decision === 'allow' ? c.json(hookDecision('allow')) : deny(cached.reasons)

    const eventId = randomId('evt')
    const args = JSON.stringify(toolInput ?? {})
    const kind: EventKind = AGENT_TOOLS.includes(toolName) ? 'agent_message' : 'tool_call'
    const resourceIds = session.state?.resourceIds ?? []
    const event: GatewayEvent = {
      id: eventId,
      orgId: principal.orgId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      sessionId: session.id,
      kind,
      model: null,
      mcpServerId: null,
      toolName,
      resourceIds,
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
    const record = () => {
      event.latencyMs = Date.now() - started
      event.overheadMs = event.latencyMs
      c.executionCtx.waitUntil(
        recordEvent(c.env, event, {
          input: { text: args, toolName, toolArguments: toolInput },
        }),
      )
    }

    // The hook never sees the call finish, so only request limits apply here, not concurrency.
    const limits = await checkLimits(
      c.env,
      await loadLimits(db, principal.orgId),
      { scope: 'tool', toolName, mcpServerId: null, resourceIds },
      {
        orgId: principal.orgId,
        userId: principal.userId,
        groupIds: await userGroupIds(db, principal),
      },
    )
    event.checks = limits.checks
    if (limits.blocked) {
      event.decision = 'rate_limited'
      record()
      return deny([limits.blocked.reason])
    }

    const result = await runPipeline(
      c.env,
      db,
      principal,
      { kind, text: args, toolName, resourceIds, toolArguments: toolInput },
      {
        eventId,
        sessionId: session.id,
        summary: `${toolName}: ${args.slice(0, 200)}`,
        limits: limits.states,
      },
    )
    event.decision = result.decision
    event.checks = [...limits.checks, ...result.checks]
    event.riskScore = result.riskScore
    event.workflows = result.workflows
    record()
    const allowed = result.decision === 'allow' || result.decision === 'approved'
    c.executionCtx.waitUntil(
      rememberVerdict(c.env, principal.orgId, session.id, toolName, toolInput, {
        decision: allowed ? 'allow' : 'block',
        reasons: result.reasons,
        eventId,
      }),
    )
    return allowed ? c.json(hookDecision('allow')) : deny(result.reasons)
  })

  /**
   * Agent-to-agent traffic. An orchestrator, an A2A proxy or an SDK wrapper posts each message
   * one agent hands to another here before delivering it, and delivers `text` from the answer:
   * the message runs through the same workflow as a prompt, as untrusted input, and comes back
   * redacted when the path includes a redaction block. Route on the kind "Agent-to-agent
   * messages" to give this traffic its own path.
   */
  .post('/inspect', async (c) => {
    const started = Date.now()
    const body = inspectInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const session = await resolveSession(c, body.data.session_id ?? null)
    if ('error' in session) return c.json({ error: session.error }, 403)

    const principal = c.get('principal')
    const eventId = randomId('evt')
    const route = `${body.data.from} → ${body.data.to}`
    const result = await runPipeline(
      c.env,
      c.get('db'),
      principal,
      {
        kind: 'agent_message',
        text: body.data.text,
        toolName: null,
        resourceIds: session.state?.resourceIds ?? [],
      },
      {
        eventId,
        sessionId: session.id,
        summary: `Agent message ${route}: ${body.data.text.slice(0, 200)}`,
      },
    )
    const allowed = result.decision === 'allow' || result.decision === 'approved'
    let text = body.data.text
    if (allowed && result.redact) {
      const stub = session.id ? sessionStub(c.env, principal.orgId, session.id) : null
      const vault = new RedactionVault(stub ? await stub.getVault() : {})
      const before = vault.size
      text = vault.redact(text, result.redact).text
      if (stub && vault.size !== before) await stub.saveVault(vault.toJSON())
    }
    const event: GatewayEvent = {
      id: eventId,
      orgId: principal.orgId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      sessionId: session.id,
      kind: 'agent_message',
      model: null,
      mcpServerId: null,
      toolName: route,
      resourceIds: session.state?.resourceIds ?? [],
      decision: result.decision,
      checks: result.checks,
      riskScore: result.riskScore,
      workflows: result.workflows,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      upstreamStatus: null,
      ...clientInfo(c),
      payloadKey: null,
      createdAt: new Date(started).toISOString(),
    }
    c.executionCtx.waitUntil(
      recordEvent(c.env, event, { input: { text: body.data.text, toolName: null } }),
    )
    return c.json(
      allowed ? { decision: 'allow', text } : { decision: 'block', reasons: result.reasons },
      allowed ? 200 : 403,
    )
  })

/**
 * An empty object for "allow" keeps Claude Code's own permission prompts in place;
 * `permissionDecision: "allow"` would silently skip them.
 */
function hookDecision(decision: 'allow' | 'deny', reason?: string) {
  if (decision === 'allow') return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  }
}
