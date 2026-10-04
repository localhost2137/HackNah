import { type Db, mcpServer } from '@acl/db'
import {
  type Decision,
  type GatewayEvent,
  type RedactConfig,
  RedactionVault,
  randomId,
  toolTierFromAnnotations,
} from '@acl/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { type AppContext, type AppEnv, clientInfo } from '../context.ts'
import { sessionStub } from '../do/session.ts'
import {
  accessibleResources,
  isAdmin,
  type McpAccess,
  mcpAccess,
  mcpServerVisible,
  mcpToolAccess,
  userGroupIds,
} from '../lib/access.ts'
import { requireGatewayToken } from '../lib/auth.ts'
import { recordEvent } from '../lib/events.ts'
import { checkLimits } from '../lib/limits.ts'
import { runPipeline } from '../lib/pipeline.ts'
import { type ResolvedSession, resolveSession } from '../lib/session.ts'
import { markResultChecked } from '../lib/verdicts.ts'
import { loadLimits } from '../lib/workflow.ts'
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  McpClient,
  type McpTool,
} from '../mcp/client.ts'
import { upstreamToken } from '../mcp/credentials.ts'

const TOOL_SEPARATOR = '__'
const TOOLS_STALE_MS = 15 * 60_000

type Server = typeof mcpServer.$inferSelect

/**
 * One MCP endpoint in front of every MCP server the org connected. Claude Code authenticates
 * once with the gateway token; upstream credentials never leave the gateway.
 */
export const mcp = new Hono<AppEnv>()
  .use('*', requireGatewayToken())
  .get('/', (c) => c.body(null, 405))
  .delete('/', (c) => c.body(null, 204))
  .post('/', async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload) return c.json(rpcError(null, -32700, 'Parse error'), 400)
    const session = await resolveSession(c)
    if ('error' in session) return c.json(rpcError(null, -32001, session.error), 403)

    const batch = Array.isArray(payload)
    const messages = (batch ? payload : [payload]) as JsonRpcRequest[]
    const responses: JsonRpcResponse[] = []
    for (const msg of messages) {
      const res = await handle(c, session, msg)
      if (res) responses.push(res)
    }
    if (responses.length === 0) return c.body(null, 202)
    return c.json(batch ? responses : responses[0])
  })

async function handle(
  c: AppContext,
  session: ResolvedSession,
  msg: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  if (msg.id === undefined || msg.id === null) return null // notification
  const id = msg.id
  try {
    switch (msg.method) {
      case 'initialize': {
        const requested = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion
        return rpcResult(id, {
          protocolVersion: requested ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'acl', title: 'AI Control Layer', version: '0.1.0' },
          instructions:
            'Tools from the company MCP servers you have access to. Names are prefixed with the server, e.g. github__create_issue.',
        })
      }
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: await listTools(c, session) })
      case 'tools/call': {
        const params = msg.params as { name?: string; arguments?: unknown } | undefined
        if (!params?.name) return rpcError(id, -32602, 'Missing tool name')
        return rpcResult(id, await callTool(c, session, params.name, params.arguments))
      }
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`)
    }
  } catch (err) {
    return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error')
  }
}

async function userMcpAccess(c: AppContext, session: ResolvedSession): Promise<McpAccess> {
  const [resources, admin] = await Promise.all([
    accessibleResources(c.get('db'), c.get('principal')),
    isAdmin(c.get('db'), c.get('principal')),
  ])
  return mcpAccess(resources, admin, session.state?.resourceIds)
}

async function orgServers(db: Db, orgId: string): Promise<Server[]> {
  return db.query.mcpServer.findMany({
    where: and(eq(mcpServer.orgId, orgId), eq(mcpServer.enabled, true)),
  })
}

async function serverTools(c: AppContext, server: Server): Promise<McpTool[]> {
  const stale =
    !server.toolsRefreshedAt || Date.now() - server.toolsRefreshedAt.getTime() > TOOLS_STALE_MS
  const cached = server.tools as McpTool[]
  if (!stale && cached.length) return cached
  try {
    return await refreshServerTools(c.env, c.get('db'), server, c.get('principal').userId)
  } catch {
    return cached
  }
}

export async function refreshServerTools(
  env: Env,
  db: Db,
  server: Server,
  userId: string,
): Promise<McpTool[]> {
  const token = await upstreamToken(env, db, server, userId)
  const tools = await new McpClient(server.url, token, `${server.id}:${userId}`).listTools()
  await db
    .update(mcpServer)
    .set({ tools, toolsRefreshedAt: new Date() })
    .where(eq(mcpServer.id, server.id))
  return tools
}

async function listTools(c: AppContext, session: ResolvedSession) {
  const access = await userMcpAccess(c, session)
  const servers = await orgServers(c.get('db'), c.get('principal').orgId)
  const out: McpTool[] = []
  for (const server of servers) {
    if (!mcpServerVisible(access, server.id)) continue
    for (const tool of await serverTools(c, server)) {
      if (!mcpToolAccess(access, server.id, tool.name).allowed) continue
      out.push({
        ...tool,
        name: `${server.slug}${TOOL_SEPARATOR}${tool.name}`,
        description: `[${server.name}] ${tool.description ?? ''}`.trim(),
      })
    }
  }
  return out
}

function toolError(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

async function callTool(c: AppContext, session: ResolvedSession, fullName: string, args: unknown) {
  const started = Date.now()
  const db = c.get('db')
  const principal = c.get('principal')
  const sep = fullName.indexOf(TOOL_SEPARATOR)
  const slug = sep > 0 ? fullName.slice(0, sep) : ''
  const toolName = sep > 0 ? fullName.slice(sep + TOOL_SEPARATOR.length) : ''
  const server = slug
    ? await db.query.mcpServer.findFirst({
        where: and(
          eq(mcpServer.orgId, principal.orgId),
          eq(mcpServer.slug, slug),
          eq(mcpServer.enabled, true),
        ),
      })
    : undefined
  if (!server || !toolName) return toolError(`Unknown tool ${fullName}`)

  const eventId = randomId('evt')
  const argsText = JSON.stringify(args ?? {})
  const event: GatewayEvent = {
    id: eventId,
    orgId: principal.orgId,
    userId: principal.userId,
    deviceId: principal.deviceId,
    sessionId: session.id,
    kind: 'tool_call',
    model: null,
    mcpServerId: server.id,
    toolName: fullName,
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
  const finish = (decision: Decision, response?: unknown) => {
    event.decision = decision
    event.latencyMs = Date.now() - started
    c.executionCtx.waitUntil(
      recordEvent(c.env, event, {
        input: { text: argsText, toolName: fullName, toolArguments: args },
        response,
      }),
    )
  }

  const granted = mcpToolAccess(await userMcpAccess(c, session), server.id, toolName)
  event.resourceIds = granted.resourceIds
  if (!granted.allowed) {
    finish('block')
    return toolError(`You don't have access to ${fullName} in this session.`)
  }

  const limits = await checkLimits(
    c.env,
    await loadLimits(db, principal.orgId),
    {
      scope: 'tool',
      mcpServerId: server.id,
      toolName: fullName,
      resourceIds: event.resourceIds,
    },
    {
      orgId: principal.orgId,
      userId: principal.userId,
      groupIds: await userGroupIds(db, principal),
    },
    { concurrency: true },
  )
  event.checks = limits.checks
  if (limits.blocked) {
    finish('rate_limited')
    const { reason, resetAt } = limits.blocked
    const wait = resetAt ? ` Retry in ${Math.ceil((resetAt - Date.now()) / 1000)}s.` : ''
    return toolError(`${reason}.${wait}`)
  }
  // Concurrency slots are held until the upstream answers.
  const callWithinLimits = async () => {
    const result = await runPipeline(
      c.env,
      db,
      principal,
      {
        kind: 'tool_call',
        text: argsText,
        toolName: fullName,
        mcpServerId: server.id,
        resourceIds: event.resourceIds,
        toolTier: toolTierFromAnnotations(
          (server.tools as McpTool[]).find((t) => t.name === toolName)?.annotations,
        ),
        toolArguments: args,
      },
      {
        eventId,
        sessionId: session.id,
        summary: `${fullName}: ${argsText.slice(0, 200)}`,
        limits: limits.states,
      },
    )
    event.checks = [...limits.checks, ...result.checks]
    event.riskScore = result.riskScore
    event.workflows = result.workflows
    if (result.decision === 'block' || result.decision === 'declined') {
      finish(result.decision)
      return toolError(`Blocked by AI Control Layer: ${result.reasons.join('; ') || 'policy'}`)
    }

    const { redact } = result
    const stub = session.id ? sessionStub(c.env, principal.orgId, session.id) : null
    const vault = new RedactionVault(stub ? await stub.getVault() : {})

    try {
      const token = await upstreamToken(c.env, db, server, principal.userId)
      const client = new McpClient(server.url, token, `${server.id}:${principal.userId}`)
      // The agent only ever saw placeholders; the upstream needs the real values.
      let response = (await client.callTool(toolName, vault.restoreDeep(args))) as ToolResponse
      event.upstreamStatus = 200

      // The result is checked before the agent sees it, as the Tool result stage.
      const checked = await checkResult(c, session, server.id, fullName, event, response)
      if (checked.withheld) {
        finish(result.decision, response)
        return toolError(`Tool result withheld by AI Control Layer: ${checked.withheld}`)
      }
      const before = vault.size
      for (const options of [redact, checked.redact]) {
        if (!options) continue
        response = {
          ...response,
          content: response.content?.map((part) =>
            part.type === 'text' && part.text
              ? { ...part, text: vault.redact(part.text, options).text }
              : part,
          ),
        }
      }
      if (stub && vault.size !== before) await stub.mergeVault(vault.toJSON())
      await markResultChecked(c.env, principal.orgId, session.id, resultText(response))
      finish(result.decision, response)
      return response
    } catch (err) {
      event.upstreamStatus = 502
      finish(result.decision)
      return toolError(err instanceof Error ? err.message : 'Upstream MCP call failed')
    }
  }
  try {
    return await callWithinLimits()
  } finally {
    await limits.release()
  }
}

type ToolResponse = { content?: { type: string; text?: string }[] }

/** The text Claude Code puts into the tool result, as the next model request will carry it. */
function resultText(response: ToolResponse): string {
  return (response.content ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n')
}

async function checkResult(
  c: AppContext,
  session: ResolvedSession,
  mcpServerId: string,
  toolName: string,
  call: GatewayEvent,
  response: ToolResponse,
): Promise<{ withheld: string | null; redact: RedactConfig | null }> {
  const text = resultText(response)
  if (!text) return { withheld: null, redact: null }
  const principal = c.get('principal')
  const started = Date.now()
  const eventId = randomId('evt')
  const result = await runPipeline(
    c.env,
    c.get('db'),
    principal,
    { kind: 'tool_result', text, toolName, mcpServerId, resourceIds: call.resourceIds },
    { eventId, sessionId: session.id, summary: `Result of ${toolName}: ${text.slice(0, 200)}` },
  )
  const event: GatewayEvent = {
    ...call,
    id: eventId,
    kind: 'tool_result',
    decision: result.decision,
    checks: result.checks,
    riskScore: result.riskScore,
    workflows: result.workflows,
    latencyMs: Date.now() - started,
    overheadMs: Date.now() - started,
    payloadKey: null,
    createdAt: new Date(started).toISOString(),
  }
  c.executionCtx.waitUntil(recordEvent(c.env, event, { input: { text, toolName } }))
  const refused = result.decision === 'block' || result.decision === 'declined'
  return {
    withheld: refused ? result.reasons.join('; ') || 'policy' : null,
    redact: refused ? null : result.redact,
  }
}

function rpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
