import { sha256Hex } from '@acl/shared'
import { sessionStub } from '../do/session.ts'

/**
 * One tool call is seen up to three times: in the model's output, by Claude Code's PreToolUse
 * hook, and by the MCP endpoint. The first stage that checks it leaves the verdict here and the
 * later ones reuse it, so one call is one event and at most one approval.
 */
export type CachedVerdict = {
  decision: 'allow' | 'block'
  reasons: string[]
  eventId: string
}

const VERDICT_TTL_MS = 2 * 60_000

/**
 * Tool names differ per stage: Claude Code sees `mcp__<server>__github__create_issue`, the
 * gateway's MCP endpoint `github__create_issue`. Both reduce to the latter.
 */
export function normalizeToolName(name: string): string {
  return name.startsWith('mcp__') ? name.replace(/^mcp__.+?__/, '') : name
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

export function verdictKey(toolName: string, args: unknown): Promise<string> {
  return sha256Hex(canonical({ tool: normalizeToolName(toolName), arguments: args ?? {} }))
}

export async function rememberVerdict(
  env: Env,
  orgId: string,
  sessionId: string | null,
  toolName: string,
  args: unknown,
  verdict: CachedVerdict,
): Promise<void> {
  if (!sessionId) return
  const key = `verdict:${await verdictKey(toolName, args)}`
  await sessionStub(env, orgId, sessionId).remember(key, verdict, VERDICT_TTL_MS)
}

export async function recallVerdict(
  env: Env,
  orgId: string,
  sessionId: string | null,
  toolName: string,
  args: unknown,
): Promise<CachedVerdict | null> {
  if (!sessionId) return null
  const key = `verdict:${await verdictKey(toolName, args)}`
  return (await sessionStub(env, orgId, sessionId).recall(key)) as CachedVerdict | null
}

/** Tool results the MCP endpoint already checked, so the next model request skips them. */
export async function markResultChecked(
  env: Env,
  orgId: string,
  sessionId: string | null,
  text: string,
): Promise<void> {
  if (!sessionId) return
  await sessionStub(env, orgId, sessionId).remember(
    `result:${await sha256Hex(text)}`,
    true,
    30 * 60_000,
  )
}

export async function resultChecked(
  env: Env,
  orgId: string,
  sessionId: string | null,
  text: string,
): Promise<boolean> {
  if (!sessionId) return false
  return (
    (await sessionStub(env, orgId, sessionId).recall(`result:${await sha256Hex(text)}`)) === true
  )
}
