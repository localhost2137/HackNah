import {
  type CheckResult,
  formatAmount,
  type LimitPrincipal,
  type LimitRule,
  type LimitState,
  type LimitStatus,
  type LimitTarget,
  limitApplies,
  limitCounterKey,
  limitState,
  randomId,
  type UsageAmounts,
  usageMeasures,
  windowLabel,
} from '@acl/shared'

export type LimitCheck = {
  /** Set when a limit whose action is `block` is exhausted. */
  blocked: { rule: LimitRule; reason: string; resetAt: number | null } | null
  /** Entries for the event: blocks and warnings. */
  checks: CheckResult[]
  /** Where the request stands against every limit that applies, for the Usage limit block. */
  states: Map<string, LimitStatus>
  /** What is left of the tightest blocking budget, for capping `max_tokens`. */
  remaining: { cost: number | null; tokens: number | null }
  /** Frees the concurrency slots this request took. Safe to call more than once. */
  release: () => Promise<void>
}

function counter(env: Env, key: string) {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key))
}

export function describeLimit(rule: LimitRule): string {
  const amount = formatAmount(rule.measure, rule.limit)
  const scope = rule.measure === 'concurrent' ? '' : ` per ${windowLabel(rule.windowSec)}`
  return rule.name || `${amount}${scope}`
}

function reasonFor(rule: LimitRule, state: LimitState, used: number): string {
  const pct = Math.round((used / rule.limit) * 100)
  const usedText =
    rule.measure === 'concurrent'
      ? `${used} running`
      : `${formatAmount(rule.measure, used)} of ${formatAmount(rule.measure, rule.limit)}`
  const head = state === 'over' ? 'Limit reached' : state === 'warn' ? 'Near limit' : 'Within limit'
  return `${head}: ${describeLimit(rule)} (${usedText}, ${pct}%)`
}

/**
 * Checks every limit that applies to a request. Budgets (tokens, USD, GPU time) are compared with
 * what was spent so far, since a call's cost is only known after it; request and concurrency
 * limits count this request. Limits set to `warn` or `workflow` never block here.
 */
export async function checkLimits(
  env: Env,
  rules: LimitRule[],
  target: LimitTarget,
  principal: LimitPrincipal,
  opts: { concurrency?: boolean } = {},
): Promise<LimitCheck> {
  const applicable = rules.filter((r) => limitApplies(r, target, principal))
  const states = new Map<string, LimitStatus>()
  const checks: CheckResult[] = []
  const leases: { key: string; id: string }[] = []
  const remaining: LimitCheck['remaining'] = { cost: null, tokens: null }
  let blocked: LimitCheck['blocked'] = null

  const note = (rule: LimitRule, state: LimitState, used: number, resetAt: number | null) => {
    const reason = reasonFor(rule, state, used)
    states.set(rule.id, { state, reason })
    if (state === 'ok' || rule.action === 'workflow') return
    const blocks = state === 'over' && rule.action === 'block'
    checks.push({
      stepId: `limit:${rule.id}`,
      type: 'limit',
      outcome: blocks ? 'fail' : 'pass',
      branch: state,
      action: blocks ? 'block' : 'log',
      reason,
      durationMs: 0,
    })
    if (blocks && !blocked) blocked = { rule, reason, resetAt }
  }

  // Budgets first: reading them has no side effects, so a request they refuse isn't counted.
  const budgets = applicable.filter((r) => usageMeasures.includes(r.measure))
  const readings = await Promise.all(
    budgets.map((r) => counter(env, limitCounterKey(r, target, principal)).peek(r.windowSec)),
  )
  budgets.forEach((rule, i) => {
    const { used, resetAt } = readings[i]!
    note(rule, limitState(rule, used), used, resetAt)
    if (rule.action !== 'block') return
    const left = Math.max(0, rule.limit - used)
    if (rule.measure === 'cost') remaining.cost = Math.min(remaining.cost ?? left, left)
    if (rule.measure === 'tokens') remaining.tokens = Math.min(remaining.tokens ?? left, left)
  })

  if (!blocked) {
    for (const rule of applicable) {
      const key = limitCounterKey(rule, target, principal)
      const enforce = rule.action === 'block'
      if (rule.measure === 'requests') {
        const res = await counter(env, key).hit(rule.limit, rule.windowSec, enforce)
        const used = rule.limit - res.remaining - (res.allowed ? 1 : 0)
        note(rule, res.allowed ? limitState(rule, used) : 'over', used, res.resetAt)
      } else if (rule.measure === 'concurrent' && opts.concurrency) {
        const id = randomId('lease')
        const res = await counter(env, key).acquire(rule.limit, id, enforce)
        if (res.acquired) leases.push({ key, id })
        note(rule, limitState(rule, res.inUse), res.inUse, null)
      }
      if (blocked) break
    }
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    await Promise.allSettled(leases.map((l) => counter(env, l.key).release(l.id)))
  }
  // A blocked request never reaches the upstream, so it gives its slots back right away.
  if (blocked) await release()
  return { blocked, checks, states, remaining, release }
}

/** Adds what an upstream call consumed to every budget that covers it. */
export async function recordUsage(
  env: Env,
  rules: LimitRule[],
  target: LimitTarget,
  principal: LimitPrincipal,
  amounts: UsageAmounts,
): Promise<void> {
  const budgets = rules.filter(
    (r) => usageMeasures.includes(r.measure) && limitApplies(r, target, principal),
  )
  await Promise.allSettled(
    budgets.map((r) => {
      const amount = amounts[r.measure as keyof UsageAmounts]
      if (!amount) return null
      return counter(env, limitCounterKey(r, target, principal)).add(amount, r.windowSec)
    }),
  )
}
