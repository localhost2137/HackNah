import { mcpServer } from '@acl/db'
import {
  AGENT_TOOLS,
  anthropicError,
  type CombinedResult,
  type EvaluationInput,
  type EventKind,
  evaluateWorkflows,
  type GatewayEvent,
  type GroupPermissions,
  type LimitStatus,
  type MessagesRequest,
  mapBlockText,
  mapRequestText,
  modelAllowed,
  parseUsage,
  type RedactConfig,
  RedactionVault,
  randomId,
  replaceToolResult,
  sessionFromMetadata,
  splitTurn,
  type TokenUsage,
  triggerMayRun,
  usageAmounts,
} from '@acl/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { type AppContext, type AppEnv, clientInfo, type Principal } from '../context.ts'
import { sessionStub } from '../do/session.ts'
import { effectivePermissions, filterToolDefinitions, userGroupIds } from '../lib/access.ts'
import { requireGatewayToken } from '../lib/auth.ts'
import { recordEvent } from '../lib/events.ts'
import { checkLimits, recordUsage } from '../lib/limits.ts'
import {
  type CatalogModel,
  fetchMessages,
  loadModels,
  routeModel,
  type UpstreamRoute,
} from '../lib/models.ts'
import {
  type GuardHooks,
  type GuardReport,
  guardMessage,
  guardStream,
} from '../lib/output-guard.ts'
import { denialMessage, guardedJudge, type PipelineResult, runPipeline } from '../lib/pipeline.ts'
import { type ResolvedSession, resolveSession } from '../lib/session.ts'
import {
  clientResponseHeaders,
  readCapped,
  type UpstreamTarget,
  upstreamRequest,
} from '../lib/upstream.ts'
import { normalizeToolName, rememberVerdict, resultChecked } from '../lib/verdicts.ts'
import { loadActiveWorkflows, loadLimits } from '../lib/workflow.ts'

const MAX_CAPTURED_RESPONSE = 256 * 1024
const MAX_RECORDED_TEXT = 64 * 1024

type Ctx = {
  c: AppContext
  principal: Principal
  session: ResolvedSession
  groupIds: string[]
  resourceIds: string[]
  model: string
}

/**
 * Anthropic Messages API proxy. Claude Code points `ANTHROPIC_BASE_URL` here, so every model
 * call goes through the org's workflows on the way in and on the way out:
 *
 * - Model input: what the user turn sends as input, and each tool result in it on its own
 *   (a refused result is withheld, the rest of the turn goes on).
 * - Model output: text and tool calls, block by block, as they stream back.
 *
 * Models are routed through the model catalog, and limits on spend, tokens, GPU time, requests
 * and concurrency are checked before and charged after each call.
 */
export const messages = new Hono<AppEnv>()
  .use('*', requireGatewayToken('anthropic'))
  .post('/messages', async (c) => {
    const started = Date.now()
    let body: MessagesRequest
    try {
      body = (await c.req.json()) as MessagesRequest
    } catch {
      return c.json(anthropicError('invalid_request_error', 'Body must be JSON'), 400)
    }

    const session = await resolveSession(c, sessionFromMetadata(body))
    if ('error' in session) return c.json(anthropicError('permission_error', session.error), 403)

    const principal = c.get('principal')
    const db = c.get('db')
    const model = body.model ?? ''
    const [catalog, rules, groupIds, permissions] = await Promise.all([
      loadModels(db, principal.orgId),
      loadLimits(db, principal.orgId),
      userGroupIds(db, principal),
      effectivePermissions(db, principal),
    ])
    const ctx: Ctx = {
      c,
      principal,
      session,
      groupIds,
      resourceIds: session.state?.resourceIds ?? [],
      model,
    }
    const turn = splitTurn(body)
    const event = newEvent(ctx, 'model_request', randomId('evt'), started)
    const requestSummary = {
      model: body.model,
      max_tokens: body.max_tokens,
      stream: body.stream,
      lastMessage: body.messages?.at(-1),
    }
    const payload = (response?: unknown) => ({
      input: { text: turn.input, toolName: null },
      request: requestSummary,
      response,
    })
    const refuse = (
      status: 403 | 429,
      type: 'permission_error' | 'rate_limit_error',
      why: string,
    ) => {
      event.latencyMs = Date.now() - started
      event.overheadMs = event.latencyMs
      c.executionCtx.waitUntil(recordEvent(c.env, event, payload()))
      return c.json(anthropicError(type, why), status)
    }

    const route = await routeModel(c.env, catalog, model)
    if ('error' in route) {
      event.decision = 'block'
      event.riskScore = 1
      event.checks = [
        { stepId: 'catalog', type: 'catalog', outcome: 'fail', reason: route.error, durationMs: 0 },
      ]
      return refuse(403, 'permission_error', `Blocked by AI Control Layer: ${route.error}.`)
    }

    const who = { orgId: principal.orgId, userId: principal.userId, groupIds }
    const target = { scope: 'model' as const, model }
    const limits = await checkLimits(c.env, rules, target, who, { concurrency: true })
    event.checks = limits.checks
    if (limits.blocked) {
      event.decision = 'rate_limited'
      return refuse(429, 'rate_limit_error', `AI Control Layer: ${limits.blocked.reason}.`)
    }

    const result = await runPipeline(
      c.env,
      db,
      principal,
      {
        kind: 'model_request',
        text: turn.input,
        toolName: null,
        model,
        resourceIds: ctx.resourceIds,
      },
      {
        eventId: event.id,
        sessionId: session.id,
        summary: `Prompt to ${model || 'model'}: ${turn.input.slice(0, 200)}`,
        limits: limits.states,
      },
    )
    applyResult(event, result, limits.checks)
    if (result.decision === 'block' || result.decision === 'declined') {
      await limits.release()
      return refuse(403, 'permission_error', denialMessage(result))
    }

    let outgoing = await redactIfConfigured(c.env, result.redact, principal.orgId, session.id, body)
    outgoing = await checkToolResults(ctx, turn.toolResults, outgoing, limits.states)
    outgoing = withPermittedTools(permissions, outgoing)
    outgoing = {
      ...outgoing,
      model: route.model,
      ...cappedMaxTokens(outgoing, route, limits.remaining),
    }

    const upstreamStarted = Date.now()
    let upstream: Response
    try {
      upstream = await fetchMessages(c.env, route, c.req.raw, outgoing)
    } catch (err) {
      await limits.release()
      event.upstreamStatus = 502
      event.latencyMs = Date.now() - started
      c.executionCtx.waitUntil(recordEvent(c.env, event, payload()))
      const why = err instanceof Error ? err.message : 'unreachable'
      return c.json(anthropicError('api_error', `Upstream model server failed: ${why}`), 502)
    }
    event.upstreamStatus = upstream.status
    const overheadBefore = upstreamStarted - started

    const settle = async (
      usage: TokenUsage,
      report: GuardReport<CombinedResult> | null,
      response: unknown,
    ) => {
      await limits.release()
      const inferenceMs = Date.now() - upstreamStarted
      const amounts = usageAmounts(route.entry, {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        inferenceMs,
      })
      await recordUsage(c.env, rules, target, who, amounts)
      event.inputTokens = usage.inputTokens
      event.outputTokens = usage.outputTokens
      event.cacheReadTokens = usage.cacheReadTokens
      event.cacheWriteTokens = usage.cacheWriteTokens
      event.costUsd = amounts.cost
      event.gpuMs = route.entry?.kind === 'local' ? inferenceMs : null
      event.latencyMs = Date.now() - started
      event.overheadMs = overheadBefore + (report?.checkMs ?? 0)
      await Promise.all([
        recordEvent(c.env, event, payload(response)),
        report ? recordOutputEvent(ctx, report) : null,
      ])
    }

    const guarded =
      upstream.ok &&
      upstream.body !== null &&
      (await loadActiveWorkflows(db, principal.orgId)).some((w) =>
        triggerMayRun(w.definition, ['model_output', 'tool_call', 'agent_message']),
      )

    if (!guarded || !upstream.body) {
      if (!upstream.body) {
        c.executionCtx.waitUntil(settle(parseUsage('', false), null, null))
        return new Response(null, {
          status: upstream.status,
          headers: clientResponseHeaders(upstream.headers),
        })
      }
      const [toClient, toCapture] = upstream.body.tee()
      c.executionCtx.waitUntil(
        (async () => {
          const raw = await readCapped(toCapture, MAX_CAPTURED_RESPONSE)
          await settle(parseUsage(raw, body.stream === true), null, raw)
        })(),
      )
      return new Response(toClient, {
        status: upstream.status,
        headers: clientResponseHeaders(upstream.headers),
      })
    }

    const hooks = await outputHooks(ctx, limits.states)
    if (body.stream === true) {
      const { body: guardedBody, report } = guardStream(upstream.body, hooks.hooks)
      c.executionCtx.waitUntil(
        (async () => {
          const r = await report
          await hooks.saveVault()
          await settle(usageOf(r.usage), r, { text: r.text.slice(0, MAX_RECORDED_TEXT) })
        })(),
      )
      return new Response(guardedBody, {
        status: upstream.status,
        headers: clientResponseHeaders(upstream.headers),
      })
    }

    const json = (await upstream.json()) as Parameters<typeof guardMessage>[0]
    const { message, report } = await guardMessage(json, hooks.hooks)
    c.executionCtx.waitUntil(
      (async () => {
        await hooks.saveVault()
        await settle(usageOf(json.usage ?? null), report, message)
      })(),
    )
    return new Response(JSON.stringify(message), {
      status: upstream.status,
      headers: clientResponseHeaders(upstream.headers),
    })
  })
  .get('/models', async (c) => {
    const principal = c.get('principal')
    const db = c.get('db')
    const catalog = await loadModels(db, principal.orgId)
    if (catalog.length === 0) return passthrough(c, defaultTarget(c.env))
    // Concrete catalog entries the user's groups allow; glob entries can't be listed.
    const permissions = await effectivePermissions(db, principal)
    const data = catalog
      .filter((m) => m.enabled && !m.pattern.includes('*') && modelAllowed(permissions, m.pattern))
      .map((m) => ({
        type: 'model',
        id: m.pattern,
        display_name: m.label || m.pattern,
        created_at: '2025-01-01T00:00:00Z',
      }))
    return c.json({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    })
  })
  // count_tokens and the rest pass through without policy checks, to the model's upstream.
  .all('/*', async (c) => {
    const principal = c.get('principal')
    let target = defaultTarget(c.env)
    if (c.req.method === 'POST') {
      const requested = (await c.req.raw
        .clone()
        .json()
        .catch(() => null)) as { model?: string } | null
      if (requested?.model) {
        const route = await routeModel(
          c.env,
          await loadModels(c.get('db'), principal.orgId),
          requested.model,
        )
        if ('error' in route) return c.json(anthropicError('permission_error', route.error), 403)
        // OpenAI-compatible servers have no token counting endpoint; about 4 characters a token.
        if (route.format === 'openai') {
          if (!c.req.path.endsWith('/count_tokens'))
            return c.json(
              anthropicError('invalid_request_error', 'Not supported for this model'),
              404,
            )
          const chars = JSON.stringify(requested).length
          return c.json({ input_tokens: Math.ceil(chars / 4) })
        }
        target = route
      }
    }
    return passthrough(c, target)
  })

function defaultTarget(env: Env): UpstreamTarget {
  return { baseUrl: env.UPSTREAM_BASE_URL, apiKey: env.OPENROUTER_API_KEY }
}

async function passthrough(c: AppContext, target: UpstreamTarget) {
  const path = new URL(c.req.url).pathname
  const upstream = await fetch(upstreamRequest(c.env, target, c.req.raw, path))
  return new Response(upstream.body, {
    status: upstream.status,
    headers: clientResponseHeaders(upstream.headers),
  })
}

function newEvent(ctx: Ctx, kind: EventKind, id: string, started: number): GatewayEvent {
  const { principal, session } = ctx
  return {
    id,
    orgId: principal.orgId,
    userId: principal.userId,
    deviceId: principal.deviceId,
    sessionId: session.id,
    kind,
    model: ctx.model || null,
    mcpServerId: null,
    toolName: null,
    resourceIds: ctx.resourceIds,
    decision: 'allow',
    checks: [],
    riskScore: 0,
    workflows: [],
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    upstreamStatus: null,
    ...clientInfo(ctx.c),
    payloadKey: null,
    createdAt: new Date(started).toISOString(),
  }
}

function applyResult(
  event: GatewayEvent,
  result: Pick<PipelineResult, 'decision' | 'checks' | 'riskScore' | 'workflows'>,
  before: GatewayEvent['checks'] = [],
) {
  event.decision = result.decision
  event.checks = [...before, ...result.checks]
  event.riskScore = result.riskScore
  event.workflows = result.workflows
}

const agentStage = (toolName: string | null): EventKind =>
  toolName && AGENT_TOOLS.includes(toolName) ? 'agent_message' : 'tool_result'

/**
 * Runs every new tool result through the Tool result stage (results of Task/Agent through Agent
 * message). A refused result is withheld from the model and the turn goes on without it.
 * Results the gateway's MCP endpoint already checked are skipped.
 */
async function checkToolResults(
  ctx: Ctx,
  results: ReturnType<typeof splitTurn>['toolResults'],
  body: MessagesRequest,
  limits: Map<string, LimitStatus>,
): Promise<MessagesRequest> {
  const { c, principal, session } = ctx
  const pending = (
    await Promise.all(
      results.map(async (r) =>
        r.text && !(await resultChecked(c.env, principal.orgId, session.id, r.text)) ? r : null,
      ),
    )
  ).filter((r) => r !== null)
  if (pending.length === 0) return body

  const stub = session.id ? sessionStub(c.env, principal.orgId, session.id) : null
  const vault = new RedactionVault(stub ? await stub.getVault() : {})
  const before = vault.size
  let out = body
  await Promise.all(
    pending.map(async (r) => {
      const started = Date.now()
      const kind = agentStage(r.toolName)
      const event = newEvent(ctx, kind, randomId('evt'), started)
      event.toolName = r.toolName
      const result = await runPipeline(
        c.env,
        c.get('db'),
        principal,
        {
          kind,
          text: r.text,
          toolName: r.toolName,
          model: ctx.model,
          resourceIds: ctx.resourceIds,
        },
        {
          eventId: event.id,
          sessionId: session.id,
          summary: `Result of ${r.toolName ?? 'a tool'}: ${r.text.slice(0, 200)}`,
          limits,
        },
      )
      applyResult(event, result)
      if (result.decision === 'block' || result.decision === 'declined') {
        const why = result.reasons.join('; ') || 'policy'
        out = replaceToolResult(out, r.toolUseId, (b) => ({
          ...b,
          content: `[Tool result withheld by AI Control Layer: ${why}]`,
          is_error: true,
        }))
      } else if (result.redact) {
        const options = result.redact
        out = replaceToolResult(out, r.toolUseId, (b) =>
          mapBlockText(b, (t) => vault.redact(t, options).text),
        )
      }
      event.latencyMs = Date.now() - started
      event.overheadMs = event.latencyMs
      c.executionCtx.waitUntil(
        recordEvent(c.env, event, { input: { text: r.text, toolName: r.toolName } }),
      )
    }),
  )
  if (stub && vault.size !== before) await stub.mergeVault(vault.toJSON())
  return out
}

function usageOf(raw: Record<string, number> | null): TokenUsage {
  return {
    inputTokens: raw?.input_tokens ?? null,
    outputTokens: raw?.output_tokens ?? null,
    cacheWriteTokens: raw?.cache_creation_input_tokens ?? null,
    cacheReadTokens: raw?.cache_read_input_tokens ?? null,
  }
}

/**
 * The output guard's checks. Text runs through the Model output stage; the judge only runs once
 * a text block is complete, earlier checks are deterministic. Tool calls run through Tool call
 * (Task/Agent through Agent message) with approvals, and their verdict is kept for the hook and
 * the MCP endpoint. Calls to the gateway's own MCP tools are left to the MCP endpoint, which
 * knows their server and tier.
 */
async function outputHooks(ctx: Ctx, limits: Map<string, LimitStatus>) {
  const { c, principal, session } = ctx
  const db = c.get('db')
  const [workflows, servers] = await Promise.all([
    loadActiveWorkflows(db, principal.orgId),
    db.query.mcpServer.findMany({
      columns: { slug: true },
      where: and(eq(mcpServer.orgId, principal.orgId), eq(mcpServer.enabled, true)),
    }),
  ])
  const gatewayTool = (name: string) => {
    if (!name.startsWith('mcp__')) return false
    const bare = normalizeToolName(name)
    return servers.some((s) => bare.startsWith(`${s.slug}__`))
  }
  const stub = session.id ? sessionStub(c.env, principal.orgId, session.id) : null
  const vault = new RedactionVault(stub ? await stub.getVault() : {})
  const before = vault.size
  const base: Omit<EvaluationInput, 'kind' | 'text'> = {
    toolName: null,
    model: ctx.model,
    deviceStatus: principal.deviceStatus,
    groupIds: ctx.groupIds,
    resourceIds: ctx.resourceIds,
  }

  const hooks: GuardHooks<CombinedResult> = {
    checkText: async (text, final) => {
      const result = await evaluateWorkflows(
        workflows,
        { ...base, kind: 'model_output', text },
        {
          judge: final
            ? (check, input) => guardedJudge(c.env, db, principal, ctx.groupIds, check, input)
            : async () => ({ score: 0, reason: 'Checked once the block is complete' }),
          limit: async (id) =>
            limits.get(id) ?? { state: 'ok', reason: 'This limit does not cover this request' },
        },
      )
      const redact: RedactConfig | null = result.redact
      return {
        action: result.decision === 'allow' ? 'allow' : 'block',
        reason: result.reasons.join('; ') || undefined,
        redact: redact ? (t) => vault.redact(t, redact).text : undefined,
        detail: result,
      }
    },
    checkToolUse: async (tool) => {
      if (gatewayTool(tool.name)) return { allow: true }
      const started = Date.now()
      const kind: EventKind = AGENT_TOOLS.includes(tool.name) ? 'agent_message' : 'tool_call'
      const event = newEvent(ctx, kind, randomId('evt'), started)
      event.toolName = tool.name
      const text = JSON.stringify(tool.input ?? {})
      const result = await runPipeline(
        c.env,
        db,
        principal,
        {
          kind,
          text,
          toolName: tool.name,
          model: ctx.model,
          resourceIds: ctx.resourceIds,
          toolArguments: tool.input,
        },
        {
          eventId: event.id,
          sessionId: session.id,
          summary: `${tool.name}: ${text.slice(0, 200)}`,
          limits,
        },
      )
      applyResult(event, result)
      event.latencyMs = Date.now() - started
      event.overheadMs = event.latencyMs
      const allow = result.decision === 'allow' || result.decision === 'approved'
      c.executionCtx.waitUntil(
        Promise.all([
          recordEvent(c.env, event, {
            input: { text, toolName: tool.name, toolArguments: tool.input },
          }),
          rememberVerdict(c.env, principal.orgId, session.id, tool.name, tool.input, {
            decision: allow ? 'allow' : 'block',
            reasons: result.reasons,
            eventId: event.id,
          }),
        ]),
      )
      return { allow, reason: result.reasons.join('; ') || undefined }
    },
  }
  return {
    hooks,
    saveVault: async () => {
      if (stub && vault.size !== before) await stub.mergeVault(vault.toJSON())
    },
  }
}

/** One Model output event per response, with the checks of its last text verdict. */
async function recordOutputEvent(ctx: Ctx, report: GuardReport<CombinedResult>) {
  const detail = report.detail
  if (!detail) return
  const event = newEvent(ctx, 'model_output', randomId('evt'), Date.now())
  event.decision = report.withheld ? 'block' : 'allow'
  event.checks = detail.checks
  event.riskScore = detail.riskScore
  event.workflows = detail.workflows
  event.latencyMs = report.checkMs
  event.overheadMs = report.checkMs
  await recordEvent(ctx.c.env, event, {
    input: { text: report.text.slice(0, MAX_RECORDED_TEXT), toolName: null },
  })
}

/**
 * Caps `max_tokens` so one answer can't run past what is left of a blocking budget. Only for
 * models with a price per output token; tokens already used by the prompt are not known yet.
 */
function cappedMaxTokens(
  body: MessagesRequest,
  route: UpstreamRoute,
  remaining: { cost: number | null; tokens: number | null },
): { max_tokens?: number } {
  const requested = typeof body.max_tokens === 'number' ? body.max_tokens : null
  if (requested === null) return {}
  let cap = Number.POSITIVE_INFINITY
  const entry: CatalogModel | null = route.entry
  if (remaining.cost !== null && entry?.kind === 'external' && entry.outputUsdPerMTok > 0)
    cap = Math.min(cap, Math.floor((remaining.cost * 1_000_000) / entry.outputUsdPerMTok))
  if (remaining.tokens !== null) cap = Math.min(cap, Math.floor(remaining.tokens))
  if (!Number.isFinite(cap) || cap >= requested) return {}
  return { max_tokens: Math.max(1, cap) }
}

function withPermittedTools(permissions: GroupPermissions, body: MessagesRequest): MessagesRequest {
  if (!Array.isArray(body.tools)) return body
  const tools = filterToolDefinitions(permissions, body.tools as { name?: unknown }[])
  if (tools.length === body.tools.length) return body
  const { tool_choice, ...rest } = body
  const choice = tool_choice as { type?: string; name?: string } | undefined
  const keepChoice =
    choice &&
    tools.length > 0 &&
    (choice.type !== 'tool' || tools.some((t) => t.name === choice.name))
  return {
    ...rest,
    ...(tools.length ? { tools } : {}),
    ...(keepChoice ? { tool_choice } : {}),
  }
}

async function redactIfConfigured(
  env: Env,
  step: RedactConfig | null,
  orgId: string,
  sessionId: string | null,
  body: MessagesRequest,
): Promise<MessagesRequest> {
  if (!step) return body
  const stub = sessionId ? sessionStub(env, orgId, sessionId) : null
  const vault = new RedactionVault(stub ? await stub.getVault() : {})
  const before = vault.size
  const redacted = mapRequestText(
    body,
    (t) => vault.redact(t, { secrets: step.secrets, pii: step.pii }).text,
  )
  if (stub && vault.size !== before) await stub.mergeVault(vault.toJSON())
  return redacted
}
