import {
  type ActiveGuardrail,
  type DeviceStatus,
  evaluateGuardrails,
  type RequestSignals,
  type ToolTier,
} from '@acl/shared'
import type { McpTool } from '../mcp/client.ts'
import { stableStringify } from './canonical.ts'

/** A tool the user can see through the gateway, with what a guardrail needs to know about it. */
export type ListedTool = {
  tool: McpTool
  /** Null for the gateway's own platform tools. */
  serverId: string | null
  tier: ToolTier
  resourceIds: string[]
  /** Hash of the definition an admin pinned, if any. */
  pin: string | null
}

/** How the plugin approves a call before sending it; `hide`: the call would always be refused. */
export type ToolLevel = 'none' | 'confirm' | 'touchid' | 'browser' | 'hide'

/**
 * A device with nothing wrong with it, asking for no approval yet. What it cannot change between
 * requests (its key storage, whether it has a Touch ID key) is taken from the real device.
 */
export function healthySignals(
  device: Pick<RequestSignals, 'keyStorage' | 'presenceCapable'>,
): RequestSignals {
  return {
    keyStorage: device.keyStorage,
    presenceCapable: device.presenceCapable,
    presenceVerified: false,
    approvedChallenge: false,
    confirmed: false,
    ipKnown: true,
    travelKmh: null,
    untrustedContentMinutesAgo: null,
    untrustedSource: null,
    hookCorrelated: true,
    userIdleMinutes: 0,
    postureStatus: 'ok',
    postureScore: 100,
    postureReason: null,
    osPosture: { fv: true, sip: true, gk: true, fw: true },
    definitionChanged: false,
  }
}

/**
 * The approval each tool needs on a good day: the tool is dry-run through the guardrails as a
 * call with no arguments from a healthy device. The approval a guardrail then asks the device
 * for is the level the plugin applies up front; a guardrail that blocks even this call hides the
 * tool. An admin approval is not a device-side level: such a call waits in the dashboard queue.
 *
 * This is a forecast for the plugin's UI. Every real call is evaluated again with its own
 * arguments and signals.
 */
export async function toolLevels(
  guardrails: ActiveGuardrail[],
  tools: ListedTool[],
  who: { groupIds: string[]; deviceStatus: DeviceStatus; signals: RequestSignals },
): Promise<Map<string, ToolLevel>> {
  const levels = new Map<string, ToolLevel>()
  await Promise.all(
    tools.map(async ({ tool, serverId, tier, resourceIds }) => {
      const result = await evaluateGuardrails(
        guardrails,
        {
          kind: 'tool_call',
          text: '{}',
          toolName: tool.name,
          mcpServerId: serverId,
          resourceIds,
          toolTier: tier,
          toolArguments: {},
          groupIds: who.groupIds,
          deviceStatus: who.deviceStatus,
          signals: who.signals,
        },
        {
          // A forecast must cost nothing: no judge call, no model, no limit counted.
          judge: async () => ({ score: 0, reason: 'Not judged in a dry run' }),
          limit: async () => ({ state: 'ok', reason: 'Not counted in a dry run' }),
        },
      )
      levels.set(
        tool.name,
        result.decision === 'block'
          ? 'hide'
          : result.decision === 'pending' && result.approvalMethod !== 'admin'
            ? (result.approvalMethod ?? 'none')
            : 'none',
      )
    }),
  )
  return levels
}

const DEFAULT_UNTRUSTED_WINDOW_MIN = 10

/** The longest window any enabled Untrusted content block uses. */
function untrustedWindow(guardrails: ActiveGuardrail[]): number {
  const windows = guardrails.flatMap((g) =>
    g.definition.nodes.flatMap((n) =>
      n.type === 'check' && n.enabled && n.check.type === 'untrusted_content'
        ? [n.check.windowMinutes]
        : [],
    ),
  )
  return windows.length ? Math.max(...windows) : DEFAULT_UNTRUSTED_WINDOW_MIN
}

export type PluginPolicy = {
  version: string
  refresh_seconds: number
  default_action: 'allow'
  tools: { match: string; action: 'allow' | 'hide'; tier: ToolTier; approval?: ToolLevel }[]
  approval_defaults: Record<ToolTier, 'none'>
  untrusted_content: { builtin_sources: string[]; window_minutes: number }
  argument_rules: never[]
  pinning: 'enforce'
  pinned: Record<string, string>
  telemetry: { flush_seconds: number }
}

/**
 * The policy document of contract §6, derived from the guardrails. Tools get one exact rule each.
 * Argument rules stay server-side: a guardrail may scope them in ways a glob list cannot express,
 * and the gateway enforces them on every call anyway.
 */
export async function buildPolicy(
  guardrails: ActiveGuardrail[],
  tools: ListedTool[],
  levels: Map<string, ToolLevel>,
  hash: (text: string) => Promise<string>,
): Promise<{ policy: PluginPolicy; etag: string }> {
  const body: Omit<PluginPolicy, 'version'> = {
    refresh_seconds: 30,
    default_action: 'allow',
    tools: tools.map(({ tool, tier }) => {
      const level = levels.get(tool.name) ?? 'none'
      return level === 'hide'
        ? { match: tool.name, action: 'hide', tier }
        : { match: tool.name, action: 'allow', tier, approval: level }
    }),
    approval_defaults: { read: 'none', write: 'none', destructive: 'none' },
    untrusted_content: {
      builtin_sources: ['WebFetch', 'WebSearch'],
      window_minutes: untrustedWindow(guardrails),
    },
    argument_rules: [],
    pinning: 'enforce',
    pinned: Object.fromEntries(
      tools.flatMap(({ tool, pin }) => (pin ? [[tool.name, pin] as const] : [])),
    ),
    telemetry: { flush_seconds: 5 },
  }
  const digest = (await hash(stableStringify(body))).slice(0, 16)
  return { policy: { version: digest, ...body }, etag: `"${digest}"` }
}
