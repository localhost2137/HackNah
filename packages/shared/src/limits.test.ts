import { describe, expect, it } from 'vitest'
import {
  findModel,
  type LimitRule,
  limitApplies,
  limitCounterKey,
  limitRule,
  limitRuleIssue,
  limitState,
  type ModelEntry,
  modelEntry,
  usageAmounts,
} from './limits.ts'

const rule = (r: Partial<LimitRule>): LimitRule =>
  limitRule.parse({ id: 'lim', scope: 'model', target: '*', limit: 10, windowSec: 86_400, ...r })
const model = (m: Partial<ModelEntry>): ModelEntry =>
  modelEntry.parse({ id: 'm', pattern: '*', ...m })

const alice = { orgId: 'org', userId: 'alice', groupIds: ['grp_all', 'grp_ml'] }
const bob = { orgId: 'org', userId: 'bob', groupIds: ['grp_all'] }

describe('usageAmounts', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheWriteTokens: 200_000,
    cacheReadTokens: 2_000_000,
    inferenceMs: 90_000,
  }

  it('prices external models per token, cache reads and writes included', () => {
    const sonnet = model({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheWriteUsdPerMTok: 3.75,
      cacheReadUsdPerMTok: 0.3,
    })
    const a = usageAmounts(sonnet, usage)
    // 3 + 1.5 + 0.75 + 0.6
    expect(a.cost).toBeCloseTo(5.85)
    expect(a.tokens).toBe(3_300_000)
    expect(a.gpu_seconds).toBe(0)
  })

  it('charges local models by GPU time', () => {
    const llama = model({ kind: 'local', gpuUsdPerHour: 2, inputUsdPerMTok: 99 })
    const a = usageAmounts(llama, usage)
    expect(a.gpu_seconds).toBe(90)
    expect(a.cost).toBeCloseTo(0.05)
    expect(a.tokens).toBe(3_300_000)
  })

  it('counts tokens for models outside the catalog, at no cost', () => {
    expect(usageAmounts(null, usage)).toEqual({ tokens: 3_300_000, cost: 0, gpu_seconds: 0 })
  })
})

describe('findModel', () => {
  it('takes the first enabled entry that matches', () => {
    const catalog = [
      model({ id: 'off', pattern: 'claude-*', enabled: false }),
      model({ id: 'sonnet', pattern: 'claude-sonnet-*' }),
      model({ id: 'claude', pattern: 'claude-*' }),
    ]
    expect(findModel(catalog, 'claude-sonnet-4-5')?.id).toBe('sonnet')
    expect(findModel(catalog, 'claude-haiku-4-5')?.id).toBe('claude')
    expect(findModel(catalog, 'llama3.1:8b')).toBeNull()
  })
})

describe('limitApplies', () => {
  it('matches model globs and only the group a group limit is for', () => {
    const team = rule({ target: 'claude-*', per: 'group_total', groupId: 'grp_ml' })
    expect(limitApplies(team, { scope: 'model', model: 'claude-opus-4-5' }, alice)).toBe(true)
    expect(limitApplies(team, { scope: 'model', model: 'claude-opus-4-5' }, bob)).toBe(false)
    expect(limitApplies(team, { scope: 'model', model: 'llama3' }, alice)).toBe(false)
    expect(limitApplies(team, { scope: 'guardrails', model: 'claude-x' }, alice)).toBe(false)
  })

  it('matches tools by full or bare name, and MCP servers by id', () => {
    const call = {
      scope: 'tool' as const,
      toolName: 'github__delete_repo',
      mcpServerId: 'srv_gh',
      resourceIds: ['res_repos'],
    }
    expect(limitApplies(rule({ scope: 'tool', target: 'delete_*' }), call, bob)).toBe(true)
    expect(limitApplies(rule({ scope: 'tool', target: 'Bash' }), call, bob)).toBe(false)
    expect(limitApplies(rule({ scope: 'mcp', target: 'srv_gh' }), call, bob)).toBe(true)
    expect(limitApplies(rule({ scope: 'resource', target: 'res_repos' }), call, bob)).toBe(true)
    const builtin = { ...call, toolName: 'Bash', mcpServerId: null, resourceIds: [] }
    expect(limitApplies(rule({ scope: 'mcp', target: '*' }), builtin, bob)).toBe(false)
  })
})

describe('limitCounterKey', () => {
  const opus = { scope: 'model' as const, model: 'claude-opus-4-5' }
  const haiku = { scope: 'model' as const, model: 'claude-haiku-4-5' }

  it('adds budgets up across every model the rule covers', () => {
    const r = rule({ target: 'claude-*' })
    expect(limitCounterKey(r, opus, alice)).toBe(limitCounterKey(r, haiku, alice))
  })

  it('counts per user, per group member, per group or per org', () => {
    const key = (r: Partial<LimitRule>, who = alice) => limitCounterKey(rule(r), opus, who)
    expect(key({ per: 'user' })).not.toBe(key({ per: 'user' }, bob))
    expect(key({ per: 'group_member', groupId: 'grp_all' })).not.toBe(
      key({ per: 'group_member', groupId: 'grp_all' }, bob),
    )
    expect(key({ per: 'group_total', groupId: 'grp_all' })).toBe(
      key({ per: 'group_total', groupId: 'grp_all' }, bob),
    )
    expect(key({ per: 'org' })).toBe(key({ per: 'org' }, bob))
  })

  it('counts a wildcard request limit per tool', () => {
    const r = rule({ measure: 'requests', scope: 'tool', target: '*' })
    const call = (toolName: string) => ({
      scope: 'tool' as const,
      toolName,
      mcpServerId: null,
      resourceIds: [],
    })
    expect(limitCounterKey(r, call('Bash'), alice)).not.toBe(
      limitCounterKey(r, call('Edit'), alice),
    )
  })
})

describe('limitState and limitRuleIssue', () => {
  it('warns from the warning level and is over at the limit', () => {
    const r = rule({ limit: 10, warnAtPct: 80 })
    expect(limitState(r, 7.9)).toBe('ok')
    expect(limitState(r, 8)).toBe('warn')
    expect(limitState(r, 10)).toBe('over')
  })

  it('refuses budgets on tools and group limits without a group', () => {
    expect(limitRuleIssue(rule({ measure: 'cost', scope: 'tool' }))).toMatch(/models/)
    expect(limitRuleIssue(rule({ per: 'group_total' }))).toBe('Choose a group')
    expect(limitRuleIssue(rule({ measure: 'cost', per: 'org' }))).toBeNull()
  })
})
