import { device, pluginChallenge } from '@acl/db'
import type { ToolTier } from '@acl/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { AppContext } from '../context.ts'
import { userGroupIds } from '../lib/access.ts'
import { loadActiveGuardrails } from '../lib/guardrail.ts'
import type { PluginRequest } from './auth.ts'
import { actionHash } from './canonical.ts'
import { healthySignals, type ListedTool, type ToolLevel, toolLevels } from './policy.ts'
import { publicUrl } from './store.ts'

export const ERR_CHALLENGE = -32010
export const ERR_DENIED = -32011

export const CHALLENGE_TTL_SEC = 120
/** An approval is for a call the user is waiting on: it has to be used soon after it is given. */
const APPROVAL_USE_WITHIN_MS = 5 * 60_000
const HOOK_MAX_AGE_SEC = 120
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/
const MAX_STORED_ARGUMENTS = 64 * 1024

/** A JSON-RPC error with data, as the plugin expects for challenges and denials. */
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message)
  }
}

export type PluginCall = {
  /** SHA-256 of canonical `{tool, arguments}`. */
  hash: string
  /** Claude Code's PreToolUse hook recorded this exact call, moments ago. */
  hookCorrelated: boolean
  /** The Claude Code session of that hook record. */
  claudeSessionId: string | null
}

/**
 * Was this tool call started by Claude Code? Its PreToolUse hook records the session and the
 * hash of the call, and the bridge puts that record into the signed proof (`hook`). A call
 * without a matching, recent record was made some other way. Evidence, not proof.
 */
export async function pluginCall(
  claims: PluginRequest['claims'],
  tool: string,
  args: unknown,
  nowMs = Date.now(),
): Promise<PluginCall> {
  const hash = await actionHash(tool, args)
  const hook = (claims.hook ?? null) as { sid?: unknown; ah?: unknown; ts?: unknown } | null
  const hookCorrelated =
    hook?.ah === hash &&
    typeof hook.ts === 'number' &&
    Math.abs(nowMs / 1000 - hook.ts) <= HOOK_MAX_AGE_SEC
  const sid = hookCorrelated && typeof hook.sid === 'string' ? hook.sid : null
  return { hash, hookCorrelated, claudeSessionId: sid && SESSION_ID.test(sid) ? sid : null }
}

/**
 * Uses up the challenge named by `HY-Challenge-Id`, if the device's owner approved it for this
 * exact action. Single use: the claim is one conditional update.
 */
export async function claimApprovedChallenge(
  c: AppContext,
  plugin: PluginRequest,
  call: PluginCall,
): Promise<boolean> {
  const id = c.req.header('hy-challenge-id')
  if (!id) return false
  const now = Date.now()
  const claimed = await c
    .get('db')
    .update(pluginChallenge)
    .set({ usedAt: new Date(now) })
    .where(
      and(
        eq(pluginChallenge.id, id),
        eq(pluginChallenge.deviceId, plugin.device.id),
        eq(pluginChallenge.actionHash, call.hash),
        eq(pluginChallenge.status, 'approved'),
        isNull(pluginChallenge.usedAt),
        gt(pluginChallenge.approvedAt, new Date(now - APPROVAL_USE_WITHIN_MS)),
      ),
    )
    .returning({ id: pluginChallenge.id })
  return claimed.length > 0
}

/** Stores what the approval page shows, and returns the JSON-RPC error data for the plugin. */
export async function createChallenge(
  c: AppContext,
  plugin: PluginRequest,
  call: PluginCall,
  action: {
    tool: string
    description: string | undefined
    tier: ToolTier
    arguments: unknown
    reasons: string[]
    eventId: string
  },
) {
  const id = crypto.randomUUID()
  const dev = plugin.device
  const text = JSON.stringify(action.arguments ?? {})
  await c
    .get('db')
    .insert(pluginChallenge)
    .values({
      id,
      orgId: dev.orgId,
      deviceId: dev.id,
      userId: dev.userId,
      tool: action.tool,
      description: action.description ?? null,
      tier: action.tier,
      arguments:
        text.length > MAX_STORED_ARGUMENTS
          ? { truncated: `${text.slice(0, 2000)}…` }
          : (action.arguments ?? {}),
      actionHash: call.hash,
      reasons: action.reasons,
      deviceName: dev.label,
      deviceCode: dev.shortCode,
      keyStorage: dev.keyStorage,
      claudeSessionId: call.claudeSessionId,
      ip: plugin.network.ip,
      country: plugin.network.country,
      postureScore: plugin.posture.score,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SEC * 1000),
      eventId: action.eventId,
    })
  return {
    decision_id: action.eventId,
    challenge: {
      id,
      approve_url: publicUrl(c.env, `/challenge/${id}`),
      expires_in: CHALLENGE_TTL_SEC,
      reasons: action.reasons,
    },
  }
}

/** The approval level of each listed tool for the device that is asking. */
export async function pluginToolLevels(
  c: AppContext,
  tools: ListedTool[],
): Promise<Map<string, ToolLevel>> {
  const db = c.get('db')
  const principal = c.get('principal')
  const [guardrails, groupIds] = await Promise.all([
    loadActiveGuardrails(db, principal.orgId),
    userGroupIds(db, principal),
  ])
  return toolLevels(guardrails, tools, {
    groupIds,
    deviceStatus: principal.deviceStatus,
    signals: healthySignals(principal.signals ?? {}),
  })
}

/** Remembers that the session read outside content: later changes get a human check. */
export async function markUntrusted(c: AppContext, deviceId: string, at: Date, source: string) {
  await c
    .get('db')
    .update(device)
    .set({ untrustedAt: at, untrustedSource: source.slice(0, 200) })
    .where(eq(device.id, deviceId))
}
