import { z } from 'zod'
import { globMatch } from './engine.ts'

/**
 * Limits: request rates, concurrency and budgets (tokens, USD, GPU time), counted per user,
 * per member of a group, for a group in total or for the whole org.
 */

/** What a limit counts. */
export const limitMeasure = z.enum(['requests', 'concurrent', 'tokens', 'cost', 'gpu_seconds'])
export type LimitMeasure = z.infer<typeof limitMeasure>

/** What traffic a limit counts. `guardrails` is the control layer's own judge calls. */
export const limitScope = z.enum(['model', 'mcp', 'tool', 'resource', 'guardrails'])
export type LimitScope = z.infer<typeof limitScope>

/** Whose usage shares one counter. */
export const limitSubject = z.enum(['user', 'group_member', 'group_total', 'org'])
export type LimitSubject = z.infer<typeof limitSubject>

/**
 * What happens past the limit. `warn` lets the request through and flags it; `guardrail` does
 * nothing on its own and leaves the decision to a Usage limit block.
 */
export const limitAction = z.enum(['block', 'warn', 'guardrail'])
export type LimitAction = z.infer<typeof limitAction>

export const limitRule = z.object({
  id: z.string(),
  name: z.string().max(80).default(''),
  measure: limitMeasure.default('requests'),
  scope: limitScope,
  /**
   * Model glob, MCP server id, tool glob (`<server>__<tool>` or the bare tool name) or resource
   * id. `*` matches anything in scope.
   */
  target: z.string().min(1),
  /** Requests, concurrent requests, tokens, USD or GPU-seconds. */
  limit: z.number().positive(),
  /** Ignored for `concurrent`. */
  windowSec: z
    .number()
    .int()
    .min(1)
    .max(31 * 86_400),
  per: limitSubject.default('user'),
  /** The group for `group_member` and `group_total`. */
  groupId: z.string().nullable().default(null),
  action: limitAction.default('block'),
  /** Percent of the limit at which a request is flagged as near the limit. */
  warnAtPct: z.number().int().min(1).max(100).default(80),
})
export type LimitRule = z.infer<typeof limitRule>

export const measureUnits: Record<LimitMeasure, string> = {
  requests: 'requests',
  concurrent: 'at once',
  tokens: 'tokens',
  cost: 'USD',
  gpu_seconds: 'GPU-seconds',
}

/** Measures that are only known after the upstream answers. */
export const usageMeasures: LimitMeasure[] = ['tokens', 'cost', 'gpu_seconds']

/** Why a rule can't be saved, or null. */
export function limitRuleIssue(rule: Omit<LimitRule, 'id'>): string | null {
  const modelScope = rule.scope === 'model' || rule.scope === 'guardrails'
  if (usageMeasures.includes(rule.measure) && !modelScope)
    return 'Tokens, cost and GPU time can only be limited for models or guardrails'
  if (rule.measure === 'concurrent' && rule.scope === 'guardrails')
    return 'Concurrency is limited per model, MCP server or tool'
  if ((rule.per === 'group_member' || rule.per === 'group_total') && !rule.groupId)
    return 'Choose a group'
  return null
}

/** Model and pricing catalog: where each model is served and what it costs. */
export const modelEntry = z.object({
  id: z.string(),
  /** Glob over the model id a client asks for, e.g. `claude-sonnet-4-5*` or `llama3.1:8b`. */
  pattern: z.string().min(1),
  label: z.string().max(80).default(''),
  /** External models are charged per token, local ones per GPU-second. */
  kind: z.enum(['external', 'local']).default('external'),
  /**
   * Wire format of the upstream. `anthropic` is passed through as is; `openai` (chat completions:
   * OpenRouter, Ollama, vLLM, LM Studio, llama.cpp, LiteLLM) is translated both ways.
   */
  apiFormat: z.enum(['anthropic', 'openai']).default('anthropic'),
  /**
   * Upstream base URL: the gateway appends `/v1/messages` for `anthropic` and
   * `/chat/completions` for `openai` (so an OpenAI base usually ends in `/v1`). Empty uses the
   * gateway's default upstream (OpenRouter).
   */
  baseUrl: z.string().default(''),
  /** Model id sent upstream; empty forwards the id the client asked for. */
  upstreamModel: z.string().default(''),
  inputUsdPerMTok: z.number().min(0).default(0),
  outputUsdPerMTok: z.number().min(0).default(0),
  cacheWriteUsdPerMTok: z.number().min(0).default(0),
  cacheReadUsdPerMTok: z.number().min(0).default(0),
  /** Cost of the GPU while it serves a local model, so local usage can share a USD budget. */
  gpuUsdPerHour: z.number().min(0).default(0),
  enabled: z.boolean().default(true),
})
export type ModelEntry = z.infer<typeof modelEntry>

/** Associated data for a model's encrypted API key, so a key can't be moved to another entry. */
export const modelKeyAad = (modelId: string) => `model:${modelId}`

/** The first enabled catalog entry for a model id, in catalog order. */
export function findModel(catalog: ModelEntry[], model: string): ModelEntry | null {
  return catalog.find((m) => m.enabled && globMatch(m.pattern, model)) ?? null
}

/** What one upstream call consumed. */
export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  /** Time the upstream took to answer, from request to last byte. */
  inferenceMs: number
}

export type UsageAmounts = Record<'tokens' | 'cost' | 'gpu_seconds', number>

/**
 * Tokens, USD and GPU-seconds for one call. External models are priced per token, cache reads
 * and writes included; local models by inference time, so GPU-seconds only count for them.
 */
export function usageAmounts(entry: ModelEntry | null, usage: Usage): UsageAmounts {
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens
  if (!entry) return { tokens, cost: 0, gpu_seconds: 0 }
  if (entry.kind === 'local') {
    const gpuSeconds = usage.inferenceMs / 1000
    return { tokens, cost: (gpuSeconds / 3600) * entry.gpuUsdPerHour, gpu_seconds: gpuSeconds }
  }
  const perToken = (usdPerMTok: number, n: number) => (usdPerMTok * n) / 1_000_000
  const cost =
    perToken(entry.inputUsdPerMTok, usage.inputTokens) +
    perToken(entry.outputUsdPerMTok, usage.outputTokens) +
    perToken(entry.cacheWriteUsdPerMTok, usage.cacheWriteTokens) +
    perToken(entry.cacheReadUsdPerMTok, usage.cacheReadTokens)
  return { tokens, cost, gpu_seconds: 0 }
}

/** The traffic a limit is checked against. */
export type LimitTarget =
  | { scope: 'model'; model: string }
  | { scope: 'guardrails'; model: string }
  | { scope: 'tool'; toolName: string; mcpServerId: string | null; resourceIds: string[] }

/** Who is asking: limits for groups apply to their members only. */
export type LimitPrincipal = { orgId: string; userId: string; groupIds: string[] }

function toolGlob(pattern: string, name: string): boolean {
  return globMatch(pattern, name) || globMatch(pattern, name.slice(name.lastIndexOf('__') + 2))
}

export function limitApplies(
  rule: LimitRule,
  target: LimitTarget,
  principal: LimitPrincipal,
): boolean {
  if ((rule.per === 'group_member' || rule.per === 'group_total') && rule.groupId) {
    if (!principal.groupIds.includes(rule.groupId)) return false
  }
  switch (rule.scope) {
    case 'model':
    case 'guardrails':
      return target.scope === rule.scope && globMatch(rule.target, target.model)
    case 'mcp':
      return (
        target.scope === 'tool' &&
        target.mcpServerId != null &&
        (rule.target === '*' || rule.target === target.mcpServerId)
      )
    case 'tool':
      return target.scope === 'tool' && toolGlob(rule.target, target.toolName)
    case 'resource':
      return (
        target.scope === 'tool' &&
        (rule.target === '*'
          ? target.resourceIds.length > 0
          : target.resourceIds.includes(rule.target))
      )
  }
}

/**
 * The counter a request is charged to. Budgets on models add up across every model the rule
 * covers; a wildcard request limit on servers, tools or resources counts each one on its own,
 * so `* : 100/min` means 100 per tool.
 */
export function limitCounterKey(
  rule: LimitRule,
  target: LimitTarget,
  principal: LimitPrincipal,
): string {
  let concrete = rule.target
  if (rule.target === '*' && target.scope === 'tool') {
    if (rule.scope === 'mcp') concrete = target.mcpServerId ?? '*'
    else if (rule.scope === 'tool') concrete = target.toolName
    else if (rule.scope === 'resource') concrete = target.resourceIds.join(',')
  }
  const subject =
    rule.per === 'user'
      ? principal.userId
      : rule.per === 'group_member'
        ? `${rule.groupId}:${principal.userId}`
        : rule.per === 'group_total'
          ? `group:${rule.groupId}`
          : 'org'
  return `${principal.orgId}:${rule.id}:${concrete}:${subject}`
}

export type LimitState = 'ok' | 'warn' | 'over'

/** Where `used` stands against a rule. A request that would start at the limit is over. */
export function limitState(rule: LimitRule, used: number): LimitState {
  if (used >= rule.limit) return 'over'
  if (used >= (rule.limit * rule.warnAtPct) / 100) return 'warn'
  return 'ok'
}

export function formatAmount(measure: LimitMeasure, n: number): string {
  if (measure === 'cost') return `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en')}`
  if (measure === 'gpu_seconds')
    return n >= 3600 ? `${(n / 3600).toFixed(1)} GPU-h` : `${Math.round(n)} GPU-s`
  return `${Math.round(n).toLocaleString('en')} ${measureUnits[measure]}`
}

export const limitWindows = [
  { value: 60, label: 'minute' },
  { value: 3600, label: 'hour' },
  { value: 86_400, label: 'day' },
  { value: 7 * 86_400, label: 'week' },
  { value: 30 * 86_400, label: 'month' },
]

export function windowLabel(sec: number): string {
  return limitWindows.find((w) => w.value === sec)?.label ?? `${sec}s`
}
