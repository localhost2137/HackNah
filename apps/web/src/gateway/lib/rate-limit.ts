import type { RateLimitRule } from '@acl/shared'

export type RateLimitTarget = { mcpServerId: string; toolName: string; resourceIds: string[] }

export function matchingRules(rules: RateLimitRule[], target: RateLimitTarget): RateLimitRule[] {
  return rules.filter((r) => {
    if (r.scope === 'mcp') return r.target === '*' || r.target === target.mcpServerId
    if (r.scope === 'tool') return r.target === '*' || r.target === target.toolName
    return r.target === '*' || target.resourceIds.includes(r.target)
  })
}

/** Checks every matching rule; returns the first one that is exhausted. */
export async function enforceRateLimits(
  env: Env,
  orgId: string,
  userId: string,
  rules: RateLimitRule[],
  target: RateLimitTarget,
): Promise<{ rule: RateLimitRule; resetAt: number } | null> {
  for (const rule of matchingRules(rules, target)) {
    // Wildcard rules count per concrete target so "* : 100/min" means 100 per tool, not in total.
    const concrete =
      rule.target !== '*'
        ? rule.target
        : rule.scope === 'mcp'
          ? target.mcpServerId
          : rule.scope === 'tool'
            ? target.toolName
            : target.resourceIds.join(',')
    const subject = rule.per === 'user' ? userId : 'org'
    const key = `${orgId}:${rule.id}:${concrete}:${subject}`
    const res = await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key)).hit(
      rule.limit,
      rule.windowSec,
    )
    if (!res.allowed) return { rule, resetAt: res.resetAt }
  }
  return null
}
