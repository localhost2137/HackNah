import { blocks } from './blocks.ts'
import {
  type ApprovalMethod,
  type CheckResult,
  type EventKind,
  kindLabels,
  type WorkflowRef,
} from './events.ts'
import type {
  CheckConfig,
  CheckNode,
  CheckType,
  Condition,
  JudgeCheck,
  KeyStorage,
  MatchNode,
  OsPostureKey,
  PolicyGraph,
  PolicyNode,
  RedactConfig,
  ToolTier,
  TriggerNode,
} from './workflow.ts'

export type DeviceStatus = 'trusted' | 'new' | 'mismatch' | 'revoked'

export type PostureStatus = 'ok' | 'stale' | 'missing' | 'invalid' | 'unknown' | 'compromised'

/**
 * What the device and session report alongside a request: the plugin's `TrustSignals`
 * (claude-plugin/contract/types.ts) in camelCase. Every field is optional; a check whose signal
 * is absent is skipped and follows `pass`, except posture, which leaves through `unknown`.
 */
export type RequestSignals = {
  keyStorage?: KeyStorage
  /** A Touch ID proof was valid for this exact request. */
  presenceVerified?: boolean
  /** The device has a registered Touch ID key. */
  presenceCapable?: boolean
  /** The owner approved this exact action in the browser after a fresh sign-in. */
  approvedChallenge?: boolean
  /** The person accepted the confirmation dialog. Reported by the client, not verifiable. */
  confirmed?: boolean
  ipKnown?: boolean
  travelKmh?: number | null
  /** Minutes since the session read untrusted content; null if it never did. */
  untrustedContentMinutesAgo?: number | null
  /** What was read, e.g. "example.com (WebFetch)". */
  untrustedSource?: string | null
  hookCorrelated?: boolean
  userIdleMinutes?: number | null
  postureStatus?: PostureStatus
  postureScore?: number | null
  postureReason?: string | null
  osPosture?: Partial<Record<OsPostureKey, boolean | null>> | null
  /** The tool's definition differs from the one an admin pinned. */
  definitionChanged?: boolean
}

export type EvaluationInput = {
  kind: EventKind
  /** Flattened text of the prompt, tool results or tool arguments being checked. */
  text: string
  toolName: string | null
  deviceStatus: DeviceStatus
  mcpServerId?: string | null
  resourceIds?: string[]
  groupIds?: string[]
  model?: string | null
  toolTier?: ToolTier | null
  /** The parsed arguments of a tool call, for argument rules. */
  toolArguments?: unknown
  signals?: RequestSignals
}

export type JudgeVerdict = { score: number; reason: string }

/** Where the user stands against one limit. */
export type LimitStatus = { state: 'ok' | 'warn' | 'over'; reason: string }

export type EngineDeps = {
  judge?: (check: JudgeCheck, input: EvaluationInput) => Promise<JudgeVerdict>
  /** Reads a limit for the `limit` block; the block is skipped without it. */
  limit?: (limitId: string, input: EvaluationInput) => Promise<LimitStatus>
  now?: () => number
}

export type EvaluationResult = {
  decision: 'allow' | 'block' | 'pending'
  /** Every node the request passed through, in order, ending with the decision. */
  checks: CheckResult[]
  riskScore: number
  reasons: string[]
  /** Set when the decision is `pending`. */
  approvalTimeoutSec: number
  /** Who has to approve a `pending` request; null otherwise. */
  approvalMethod: ApprovalMethod | null
  /** Approving this request also trusts the new device it came from. */
  trustsDevice: boolean
  /** The redaction applied on the way, if the path went through an enabled redact node. */
  redact: RedactConfig | null
}

const MAX_HOPS = 64

type Outcome = Omit<CheckResult, 'stepId' | 'type' | 'durationMs' | 'branch'> & { branch: string }

export async function evaluateGraph(
  graph: PolicyGraph,
  input: EvaluationInput,
  deps: EngineDeps = {},
): Promise<EvaluationResult> {
  const now = deps.now ?? (() => performance.now())
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const edges = new Map(graph.edges.map((e) => [`${e.source}:${e.sourceHandle}`, e.target]))
  const checks: CheckResult[] = []
  let redact: RedactConfig | null = null
  let trustsDevice = false

  const finish = (
    action: 'allow' | 'block' | 'require_approval',
    entry: { stepId: string; reason?: string; timeoutSec?: number; method?: ApprovalMethod },
  ): EvaluationResult => {
    checks.push({
      stepId: entry.stepId,
      type: 'decision',
      outcome: action === 'allow' ? 'pass' : 'fail',
      action: action === 'allow' ? undefined : action,
      method: entry.method,
      reason: entry.reason || undefined,
      durationMs: 0,
    })
    const failed = checks.filter((c) => c.outcome === 'fail' && c.type !== 'decision')
    const reasons = failed.map((c) => c.reason ?? c.type)
    if (action !== 'allow' && entry.reason) reasons.push(entry.reason)
    const pendingMethod = action === 'require_approval' ? (entry.method ?? 'admin') : null
    if (pendingMethod && pendingMethod !== 'admin') reasons.push(approvalAsk[pendingMethod])
    const decisionRisk = action === 'block' ? 1 : action === 'require_approval' ? 0.7 : 0
    const riskScore = Math.min(
      1,
      Math.max(decisionRisk, failed.length ? 0.3 : 0, ...checks.map((c) => c.score ?? 0)),
    )
    return {
      decision: action === 'allow' ? 'allow' : action === 'block' ? 'block' : 'pending',
      checks,
      riskScore,
      reasons,
      approvalTimeoutSec: entry.timeoutSec ?? 300,
      approvalMethod: pendingMethod,
      trustsDevice: action === 'require_approval' && trustsDevice,
      redact,
    }
  }

  let node: PolicyNode | undefined = graph.nodes.find((n) => n.type === 'trigger')
  let from = 'start'
  for (let hop = 0; node && hop < MAX_HOPS; hop++) {
    if (node.type === 'decision') {
      if (node.action !== 'require_approval')
        return finish(node.action, { stepId: node.id, reason: node.reason })
      // Streamed output can't wait minutes for someone to decide.
      if (input.kind === 'model_output')
        return finish('block', {
          stepId: node.id,
          reason:
            node.reason || 'Model output needs approval, which streamed output cannot wait for',
        })
      const approval = resolveApproval(node.method, input.signals)
      if (approval.satisfied)
        return finish('allow', { stepId: node.id, reason: approval.satisfied, method: node.method })
      return finish('require_approval', {
        stepId: node.id,
        reason: node.reason,
        timeoutSec: node.timeoutSec,
        method: approval.method,
      })
    }

    let branch = 'next'
    if (node.type === 'match') {
      branch = matches(node, input) ? 'match' : 'else'
      checks.push({
        stepId: node.id,
        type: 'match',
        outcome: 'pass',
        branch,
        reason: node.label || undefined,
        durationMs: 0,
      })
    } else if (node.type === 'check') {
      const started = now()
      const result = await runCheck(node, input, deps)
      checks.push({
        stepId: node.id,
        type: node.check.type,
        durationMs: Math.round(now() - started),
        ...result,
        branch: result.outcome === 'error' ? undefined : result.branch,
      })
      // A check that could not run is treated like an output with nothing connected.
      if (result.outcome === 'error')
        return finish(graph.fallback, {
          stepId: '(fallback)',
          reason: `${result.reason} (workflow fallback: ${graph.fallback})`,
        })
      branch = result.branch
      if (node.enabled && node.check.type === 'redact') redact = node.check
      if (node.check.type === 'fingerprint' && branch === 'new') trustsDevice = true
    }

    from = `${node.id} → ${branch}`
    const next = edges.get(`${node.id}:${branch}`)
    node = next ? nodes.get(next) : undefined
  }

  return finish(graph.fallback, {
    stepId: '(fallback)',
    reason: node ? 'Workflow is too deep' : `Nothing connected after ${from}`,
  })
}

/** One published workflow, as the gateway loads it. */
export type ActiveWorkflow = {
  id: string
  name: string
  version: number
  /** Groups whose members this workflow runs for. Empty means every member. */
  groupIds: string[]
  definition: PolicyGraph
}

export type CombinedResult = EvaluationResult & { workflows: WorkflowRef[] }

/** The enabled workflows that run for a request: in scope for the user, and triggered by it. */
export function selectWorkflows(
  workflows: ActiveWorkflow[],
  input: EvaluationInput,
): ActiveWorkflow[] {
  const groups = new Set(input.groupIds ?? [])
  return workflows.filter(
    (w) =>
      (w.groupIds.length === 0 || w.groupIds.some((id) => groups.has(id))) &&
      triggerHolds(w.definition, input),
  )
}

/**
 * Runs every workflow the request triggers and keeps the strictest outcome: block over approval
 * over allow. A request that triggers no workflow is allowed.
 */
export async function evaluateWorkflows(
  workflows: ActiveWorkflow[],
  input: EvaluationInput,
  deps: EngineDeps = {},
): Promise<CombinedResult> {
  const now = deps.now ?? (() => performance.now())
  const selected = selectWorkflows(workflows, input)
  const results = await Promise.all(
    selected.map(async (w) => {
      const started = now()
      const result = await evaluateGraph(w.definition, input, deps)
      return { workflow: w, result, durationMs: Math.round(now() - started) }
    }),
  )
  return combineResults(results)
}

/** Stricter approvals first; the combined approval asks for the strictest one requested. */
const approvalStrength: ApprovalMethod[] = ['admin', 'browser', 'touchid', 'confirm']

export function combineResults(
  results: {
    workflow: Pick<ActiveWorkflow, 'id' | 'name' | 'version'>
    result: EvaluationResult
    durationMs?: number
  }[],
): CombinedResult {
  const workflows = results.map(({ workflow: { id, name, version }, result, durationMs }) => ({
    id,
    name,
    version,
    decision: result.decision,
    ...(durationMs === undefined ? {} : { durationMs }),
  }))
  const checks = results.flatMap(({ workflow, result }) =>
    result.checks.map((c) => ({ ...c, workflowId: workflow.id })),
  )
  const blocked = results.filter((r) => r.result.decision === 'block')
  const pending = results.filter((r) => r.result.decision === 'pending')
  const decision = blocked.length ? 'block' : pending.length ? 'pending' : 'allow'
  const deciding = blocked.length ? blocked : pending.length ? pending : results
  const methods = pending.map((r) => r.result.approvalMethod ?? 'admin')
  const method =
    decision === 'pending' ? (approvalStrength.find((m) => methods.includes(m)) ?? 'admin') : null
  const asks = new Set(Object.values(approvalAsk))
  const reasons = [
    ...new Set(deciding.flatMap((r) => r.result.reasons).filter((r) => !asks.has(r))),
  ]
  if (method && method !== 'admin') reasons.push(approvalAsk[method])

  let redact: RedactConfig | null = null
  for (const { result } of results) {
    if (!result.redact) continue
    redact = redact
      ? {
          type: 'redact',
          secrets: redact.secrets || result.redact.secrets,
          pii: [...new Set([...redact.pii, ...result.redact.pii])],
        }
      : result.redact
  }

  return {
    decision,
    checks,
    riskScore: Math.max(0, ...results.map((r) => r.result.riskScore)),
    reasons,
    approvalTimeoutSec: Math.max(0, ...pending.map((r) => r.result.approvalTimeoutSec)) || 300,
    approvalMethod: method,
    trustsDevice: decision === 'pending' && pending.some((r) => r.result.trustsDevice),
    redact,
    workflows,
  }
}

const approvalAsk: Record<Exclude<ApprovalMethod, 'admin'>, string> = {
  confirm: 'Needs confirmation in Claude Code',
  touchid: 'Needs Touch ID on the device',
  browser: 'Needs a fresh sign-in in the browser',
}

/**
 * Whether the request already carries the proof an approval asks for. An admin approval never
 * does. A browser approval of this exact action outranks the other device-side levels, and a
 * device without Touch ID is asked in the browser instead.
 */
function resolveApproval(
  method: ApprovalMethod,
  signals: RequestSignals = {},
): { method: ApprovalMethod; satisfied?: string } {
  if (method === 'admin') return { method }
  if (signals.approvedChallenge)
    return { method, satisfied: 'Approved in the browser after a fresh sign-in' }
  if (method === 'touchid') {
    if (signals.presenceVerified) return { method, satisfied: 'Touch ID verified' }
    if (signals.presenceCapable === false) return { method: 'browser' }
  }
  if (method === 'confirm' && signals.confirmed)
    return { method, satisfied: 'Confirmed in Claude Code' }
  return { method }
}

const noSignal: Outcome = {
  outcome: 'skipped',
  branch: 'pass',
  reason: 'No signal from this client',
}
const notAToolCall: Outcome = { outcome: 'skipped', branch: 'pass', reason: 'Not a tool call' }
const passed: Outcome = { outcome: 'pass', branch: 'pass' }

const osPostureNames: Record<OsPostureKey, string> = {
  fv: 'FileVault',
  sip: 'System Integrity Protection',
  gk: 'Gatekeeper',
  fw: 'Firewall',
}

type Runner<T extends CheckType> = (
  check: Extract<CheckConfig, { type: T }>,
  input: EvaluationInput,
  deps: EngineDeps,
) => Outcome | Promise<Outcome>

/** What each check block does. Its outputs are declared in `blocks.ts`. */
const runners: { [T in CheckType]: Runner<T> } = {
  fingerprint: (_, input) => {
    if (input.deviceStatus === 'mismatch' || input.deviceStatus === 'revoked')
      return {
        outcome: 'fail',
        branch: 'mismatch',
        reason:
          input.deviceStatus === 'revoked'
            ? 'Device has been revoked'
            : 'Token presented from a different device',
      }
    if (input.deviceStatus === 'new')
      return { outcome: 'fail', branch: 'new', reason: 'Request from an unrecognized device' }
    return passed
  },
  keywords: (check, input) => {
    const hit = matchKeywords(input.text, check.patterns, check.mode, check.caseSensitive)
    if (hit) return { outcome: 'fail', branch: 'fail', reason: `Matched keyword "${hit}"` }
    return passed
  },
  judge: async (check, input, deps) => {
    if (!deps.judge) throw new Error('judge unavailable')
    const verdict = await deps.judge(check, input)
    const failed = verdict.score >= check.threshold
    return {
      outcome: failed ? 'fail' : 'pass',
      branch: failed ? 'fail' : 'pass',
      score: verdict.score,
      reason: verdict.reason,
    }
  },
  // Redaction rewrites the request before forwarding; it never blocks.
  redact: () => passed,
  arguments: (check, input) => {
    const name = input.toolName
    if (input.kind !== 'tool_call' || !name) return notAToolCall
    const args =
      input.toolArguments && typeof input.toolArguments === 'object'
        ? (input.toolArguments as Record<string, unknown>)
        : {}
    for (const rule of check.rules) {
      if (!toolMatches(rule.tool, name)) continue
      const value = args[rule.argument]
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
      const re = new RegExp(rule.pattern)
      const bad = values.find((v) => !re.test(typeof v === 'string' ? v : JSON.stringify(v)))
      if (bad !== undefined)
        return {
          outcome: 'fail',
          branch: 'fail',
          reason:
            rule.message ||
            `Argument ${rule.argument}=${typeof bad === 'string' ? bad : JSON.stringify(bad)} is not allowed`,
        }
    }
    return passed
  },
  untrusted_content: (check, input) => {
    const minutes = input.signals?.untrustedContentMinutesAgo
    if (minutes === undefined) return noSignal
    if (minutes === null || minutes >= check.windowMinutes) return passed
    const source = input.signals?.untrustedSource
    return {
      outcome: 'fail',
      branch: 'tainted',
      reason: `Possible prompt injection: the session read untrusted content${source ? ` (${source})` : ''} ${minutes} min ago`,
    }
  },
  tool_pinning: (_, input) => {
    const changed = input.signals?.definitionChanged
    if (changed === undefined) return noSignal
    if (!changed) return passed
    return {
      outcome: 'fail',
      branch: 'changed',
      reason: 'Tool definition changed since an admin pinned it (possible tool poisoning)',
    }
  },
  posture: (check, input) => {
    const {
      postureStatus: status = 'missing',
      postureScore: score,
      postureReason,
    } = input.signals ?? {}
    if (status === 'compromised' || status === 'invalid')
      return {
        outcome: 'fail',
        branch: 'compromised',
        reason: postureReason || `EDR posture ${status}`,
      }
    if (score != null && score < check.minScore)
      return {
        outcome: 'fail',
        branch: 'low',
        reason: `Posture score ${score} is below ${check.minScore}`,
      }
    // An unreachable EDR or a missing score is unknown, never healthy.
    if (status !== 'ok' || score == null)
      return {
        outcome: 'fail',
        branch: 'unknown',
        reason:
          postureReason ||
          (status === 'stale'
            ? 'EDR posture is outdated'
            : status === 'missing'
              ? 'No EDR posture from this device'
              : 'EDR posture could not be confirmed'),
      }
    return passed
  },
  os_posture: (check, input) => {
    const reported = input.signals?.osPosture
    if (!reported) return noSignal
    const off = check.require.filter((key) => reported[key] === false)
    if (off.length === 0) return passed
    return {
      outcome: 'fail',
      branch: 'fail',
      reason: `${off.map((key) => osPostureNames[key]).join(', ')} off`,
    }
  },
  network: (check, input) => {
    const { ipKnown, travelKmh } = input.signals ?? {}
    if (ipKnown === undefined && travelKmh === undefined) return noSignal
    if (travelKmh != null && travelKmh > check.maxTravelKmh)
      return {
        outcome: 'fail',
        branch: 'travel',
        reason: `Impossible travel: ${Math.round(travelKmh)} km/h since the previous request`,
      }
    if (ipKnown === false)
      return {
        outcome: 'fail',
        branch: 'new_network',
        reason: 'First request from this network',
      }
    return passed
  },
  hook: (_, input) => {
    if (input.kind !== 'tool_call') return notAToolCall
    const correlated = input.signals?.hookCorrelated
    if (correlated === undefined) return noSignal
    if (correlated) return passed
    return {
      outcome: 'fail',
      branch: 'fail',
      reason: 'Tool call not started by Claude Code (no matching hook record)',
    }
  },
  limit: async (check, input, deps) => {
    if (!check.limitId) return { outcome: 'skipped', branch: 'pass', reason: 'No limit selected' }
    if (!deps.limit) return noSignal
    const status = await deps.limit(check.limitId, input)
    if (status.state === 'ok') return { ...passed, reason: status.reason || undefined }
    return {
      outcome: 'fail',
      branch: status.state,
      reason: status.reason,
    }
  },
  idle: (check, input) => {
    const minutes = input.signals?.userIdleMinutes
    if (minutes === undefined) return noSignal
    if (minutes === null || minutes < check.maxMinutes) return passed
    return { outcome: 'fail', branch: 'idle', reason: `User idle for ${minutes} min` }
  },
}

async function runCheck(
  node: CheckNode,
  input: EvaluationInput,
  deps: EngineDeps,
): Promise<Outcome> {
  if (!node.enabled) return { outcome: 'skipped', reason: 'disabled', branch: 'pass' }
  const check = node.check
  const stages = blocks[check.type].appliesTo
  if (stages && !stages.includes(input.kind))
    return { outcome: 'skipped', branch: 'pass', reason: `Not used on ${kindLabels[input.kind]}` }
  try {
    const run = runners[check.type] as Runner<CheckType>
    return await run(check, input, deps)
  } catch (err) {
    return {
      outcome: 'error',
      branch: 'pass',
      reason: `${check.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function matches(node: MatchNode | TriggerNode, input: EvaluationInput): boolean {
  const results = node.conditions.map((c) => conditionHolds(c, input))
  return node.mode === 'all' ? results.every(Boolean) : results.some(Boolean)
}

/** Whether a request starts this graph. A start node without conditions takes every request. */
export function triggerHolds(graph: PolicyGraph, input: EvaluationInput): boolean {
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  if (!trigger) return false
  return trigger.conditions.length === 0 || matches(trigger, input)
}

export function conditionHolds(c: Condition, input: EvaluationInput): boolean {
  switch (c.field) {
    case 'kind':
      return c.values.includes(input.kind)
    case 'mcpServer':
      return input.mcpServerId != null && c.values.includes(input.mcpServerId)
    case 'source':
      return (
        input.toolName != null &&
        c.values.includes(
          input.mcpServerId || input.toolName.startsWith('mcp__') ? 'mcp' : 'builtin',
        )
      )
    case 'tool':
      return input.toolName != null && c.values.some((p) => toolMatches(p, input.toolName!))
    case 'resource':
      return (input.resourceIds ?? []).some((id) => c.values.includes(id))
    case 'group':
      return (input.groupIds ?? []).some((id) => c.values.includes(id))
    case 'deviceStatus':
      return c.values.includes(input.deviceStatus as (typeof c.values)[number])
    case 'model':
      return input.model != null && c.values.some((p) => globMatch(p, input.model!))
    case 'tier':
      return input.toolTier != null && c.values.includes(input.toolTier)
    case 'keyStorage': {
      const storage = input.signals?.keyStorage
      return storage != null && c.values.includes(storage)
    }
  }
}

/** MCP tools are named `<server>__<tool>`; a pattern may target either form. */
function toolMatches(pattern: string, name: string): boolean {
  return globMatch(pattern, name) || globMatch(pattern, name.slice(name.lastIndexOf('__') + 2))
}

/**
 * The tier of an MCP tool from its annotations, as the plugin derives it: `destructiveHint` →
 * destructive, `readOnlyHint` → read, otherwise write.
 */
export function toolTierFromAnnotations(annotations: unknown): ToolTier {
  const hints = (annotations ?? {}) as { destructiveHint?: boolean; readOnlyHint?: boolean }
  if (hints.destructiveHint) return 'destructive'
  return hints.readOnlyHint ? 'read' : 'write'
}

/** Whole-string match where `*` is the only wildcard. */
export function globMatch(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(value)
}

/** Returns the first matching pattern, or null. Substring patterns support `*` as a wildcard. */
export function matchKeywords(
  text: string,
  patterns: string[],
  mode: 'substring' | 'regex',
  caseSensitive: boolean,
): string | null {
  const flags = caseSensitive ? '' : 'i'
  for (const pattern of patterns) {
    let re: RegExp
    try {
      re =
        mode === 'regex'
          ? new RegExp(pattern, flags)
          : new RegExp(pattern.split('*').map(escapeRegExp).join('.*?'), flags)
    } catch {
      continue
    }
    if (re.test(text)) return pattern
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
