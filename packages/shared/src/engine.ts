import type { CheckResult, EventKind } from './events.ts'
import {
  type CheckNode,
  type Condition,
  type JudgeCheck,
  type MatchNode,
  nodeOutputs,
  type PolicyGraph,
  type PolicyNode,
  type RedactConfig,
} from './workflow.ts'

export type DeviceStatus = 'trusted' | 'new' | 'mismatch' | 'revoked'

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
}

export type JudgeVerdict = { score: number; reason: string }

export type EngineDeps = {
  judge?: (check: JudgeCheck, input: EvaluationInput) => Promise<JudgeVerdict>
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
    entry: { stepId: string; reason?: string; timeoutSec?: number },
  ): EvaluationResult => {
    checks.push({
      stepId: entry.stepId,
      type: 'decision',
      outcome: action === 'allow' ? 'pass' : 'fail',
      action: action === 'allow' ? undefined : action,
      reason: entry.reason || undefined,
      durationMs: 0,
    })
    const failed = checks.filter((c) => c.outcome === 'fail' && c.type !== 'decision')
    const reasons = failed.map((c) => c.reason ?? c.type)
    if (action !== 'allow' && entry.reason) reasons.push(entry.reason)
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
      trustsDevice: action === 'require_approval' && trustsDevice,
      redact,
    }
  }

  let node: PolicyNode | undefined = graph.nodes.find((n) => n.type === 'trigger')
  let from = 'start'
  for (let hop = 0; node && hop < MAX_HOPS; hop++) {
    if (node.type === 'decision') {
      return finish(node.action, {
        stepId: node.id,
        reason: node.reason,
        timeoutSec: node.timeoutSec,
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
      branch = result.branch
      checks.push({
        stepId: node.id,
        type: node.check.type,
        durationMs: Math.round(now() - started),
        ...result,
      })
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

async function runCheck(
  node: CheckNode,
  input: EvaluationInput,
  deps: EngineDeps,
): Promise<Outcome> {
  if (!node.enabled) return { outcome: 'skipped', reason: 'disabled', branch: 'pass' }
  const check = node.check
  try {
    switch (check.type) {
      case 'fingerprint':
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
        return { outcome: 'pass', branch: 'pass' }
      case 'keywords': {
        const hit = matchKeywords(input.text, check.patterns, check.mode, check.caseSensitive)
        if (hit) return { outcome: 'fail', branch: 'fail', reason: `Matched keyword "${hit}"` }
        return { outcome: 'pass', branch: 'pass' }
      }
      case 'judge': {
        if (!deps.judge) throw new Error('judge unavailable')
        const verdict = await deps.judge(check, input)
        const failed = verdict.score >= check.threshold
        return {
          outcome: failed ? 'fail' : 'pass',
          branch: failed ? 'fail' : 'pass',
          score: verdict.score,
          reason: verdict.reason,
        }
      }
      case 'redact':
        // Redaction rewrites the request before forwarding; it never blocks.
        return { outcome: 'pass', branch: 'pass' }
    }
  } catch (err) {
    const outputs = nodeOutputs(node)
    return {
      outcome: 'error',
      branch: outputs.includes('error') ? 'error' : outputs.includes('fail') ? 'fail' : 'pass',
      reason: `${check.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function matches(node: MatchNode, input: EvaluationInput): boolean {
  const results = node.conditions.map((c) => conditionHolds(c, input))
  return node.mode === 'all' ? results.every(Boolean) : results.some(Boolean)
}

export function conditionHolds(c: Condition, input: EvaluationInput): boolean {
  switch (c.field) {
    case 'kind':
      return c.values.includes(input.kind)
    case 'mcpServer':
      return input.mcpServerId != null && c.values.includes(input.mcpServerId)
    case 'tool': {
      const name = input.toolName
      if (!name) return false
      // MCP tools are named `<server>__<tool>`; patterns may target either form.
      const bare = name.slice(name.lastIndexOf('__') + 2)
      return c.values.some((p) => globMatch(p, name) || globMatch(p, bare))
    }
    case 'resource':
      return (input.resourceIds ?? []).some((id) => c.values.includes(id))
    case 'group':
      return (input.groupIds ?? []).some((id) => c.values.includes(id))
    case 'deviceStatus':
      return c.values.includes(input.deviceStatus as (typeof c.values)[number])
    case 'model':
      return input.model != null && c.values.some((p) => globMatch(p, input.model!))
  }
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
