import {
  anthropicError,
  extractTurnText,
  type GatewayEvent,
  type GroupPermissions,
  type MessagesRequest,
  mapRequestText,
  parseUsage,
  type RedactConfig,
  RedactionVault,
  randomId,
  sessionFromMetadata,
} from '@acl/shared'
import { Hono } from 'hono'
import { type AppEnv, clientInfo } from '../context.ts'
import { sessionStub } from '../do/session.ts'
import { effectivePermissions, filterToolDefinitions } from '../lib/access.ts'
import { requireGatewayToken } from '../lib/auth.ts'
import { recordEvent } from '../lib/events.ts'
import { denialMessage, runPipeline } from '../lib/pipeline.ts'
import { resolveSession } from '../lib/session.ts'
import { clientResponseHeaders, readCapped, upstreamRequest } from '../lib/upstream.ts'

const MAX_CAPTURED_RESPONSE = 256 * 1024

/**
 * Anthropic Messages API proxy. Claude Code points `ANTHROPIC_BASE_URL` here, so every model
 * call goes through the org's workflow before it reaches the upstream provider.
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
    const eventId = randomId('evt')
    const text = extractTurnText(body)

    const result = await runPipeline(
      c.env,
      db,
      principal,
      {
        kind: 'model_request',
        text,
        toolName: null,
        model: body.model ?? null,
        resourceIds: session.state?.resourceIds ?? [],
      },
      {
        eventId,
        sessionId: session.id,
        summary: `Prompt to ${body.model ?? 'model'}: ${text.slice(0, 200)}`,
      },
    )

    const event: GatewayEvent = {
      id: eventId,
      orgId: principal.orgId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      sessionId: session.id,
      kind: 'model_request',
      model: body.model ?? null,
      mcpServerId: null,
      toolName: null,
      resourceIds: session.state?.resourceIds ?? [],
      decision: result.decision,
      checks: result.checks,
      riskScore: result.riskScore,
      workflows: result.workflows,
      inputTokens: null,
      outputTokens: null,
      latencyMs: 0,
      upstreamStatus: null,
      ...clientInfo(c),
      payloadKey: null,
      createdAt: new Date(started).toISOString(),
    }
    const requestSummary = {
      model: body.model,
      max_tokens: body.max_tokens,
      stream: body.stream,
      lastMessage: body.messages?.at(-1),
    }

    if (result.decision === 'block' || result.decision === 'declined') {
      event.latencyMs = Date.now() - started
      c.executionCtx.waitUntil(
        recordEvent(c.env, event, { input: { text, toolName: null }, request: requestSummary }),
      )
      return c.json(anthropicError('permission_error', denialMessage(result)), 403)
    }

    const outgoing = withPermittedTools(
      await effectivePermissions(db, principal),
      await redactIfConfigured(c.env, result.redact, principal.orgId, session.id, body),
    )
    const upstream = await fetch(
      upstreamRequest(c.env, c.req.raw, '/v1/messages', JSON.stringify(outgoing)),
    )

    event.upstreamStatus = upstream.status
    if (!upstream.body) {
      event.latencyMs = Date.now() - started
      c.executionCtx.waitUntil(
        recordEvent(c.env, event, { input: { text, toolName: null }, request: requestSummary }),
      )
      return new Response(null, {
        status: upstream.status,
        headers: clientResponseHeaders(upstream.headers),
      })
    }

    const [toClient, toCapture] = upstream.body.tee()
    c.executionCtx.waitUntil(
      (async () => {
        const raw = await readCapped(toCapture, MAX_CAPTURED_RESPONSE)
        const usage = parseUsage(raw, body.stream === true)
        event.inputTokens = usage.inputTokens
        event.outputTokens = usage.outputTokens
        event.latencyMs = Date.now() - started
        await recordEvent(c.env, event, {
          input: { text, toolName: null },
          request: requestSummary,
          response: raw,
        })
      })(),
    )
    return new Response(toClient, {
      status: upstream.status,
      headers: clientResponseHeaders(upstream.headers),
    })
  })
  // count_tokens, models, etc. pass through without policy checks.
  .all('/*', async (c) => {
    const path = new URL(c.req.url).pathname
    const upstream = await fetch(upstreamRequest(c.env, c.req.raw, path))
    return new Response(upstream.body, {
      status: upstream.status,
      headers: clientResponseHeaders(upstream.headers),
    })
  })

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
  if (stub && vault.size !== before) await stub.saveVault(vault.toJSON())
  return redacted
}
