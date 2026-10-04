import type { RateLimitRule } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import {
  applySessionScope,
  filterToolDefinitions,
  globMatch,
  mcpAccess,
  mcpServerVisible,
  mcpToolAccess,
  permissionDenial,
  resourcesForTool,
} from './access.ts'
import { matchingRules } from './rate-limit.ts'

type Row = Parameters<typeof resourcesForTool>[0][number]
const row = (id: string, mcpServerId: string, toolPatterns: string[]) =>
  ({ id, mcpServerId, toolPatterns, name: id }) as unknown as Row

describe('resource matching', () => {
  const resources = [
    row('read', 'gh', ['get_*', 'list_*', 'search_*']),
    row('all', 'gh', []),
    row('jira', 'jira', ['*']),
  ]

  it('globs tool names literally apart from *', () => {
    expect(globMatch('get_*', 'get_issue')).toBe(true)
    expect(globMatch('get.issue', 'get_issue')).toBe(false)
    expect(globMatch('create_issue', 'create_issue_comment')).toBe(false)
  })

  it('finds the resources that grant a tool', () => {
    expect(resourcesForTool(resources, 'gh', 'list_repos')).toEqual(['read', 'all'])
    expect(resourcesForTool(resources, 'gh', 'delete_repo')).toEqual(['all'])
    expect(resourcesForTool(resources, 'linear', 'list_issues')).toEqual([])
  })

  it('narrows to the session scope only when one is set', () => {
    expect(applySessionScope(resources, undefined)).toHaveLength(3)
    expect(applySessionScope(resources, ['jira']).map((r) => r.id)).toEqual(['jira'])
  })
})

describe('group permissions', () => {
  const perms = { models: ['claude-sonnet-*'], builtinTools: ['Read', 'Grep'], mcp: {} }

  it('blocks models and built-in tools the groups do not allow', () => {
    const model = (m: string) =>
      permissionDenial(perms, { kind: 'model_request', model: m, toolName: null })
    expect(model('claude-sonnet-4-5')).toBeNull()
    expect(model('claude-opus-4-1')).toMatch(/claude-opus-4-1/)
    const tool = (t: string, mcpServerId: string | null = null) =>
      permissionDenial(perms, { kind: 'tool_call', toolName: t, mcpServerId })
    expect(tool('Read')).toBeNull()
    expect(tool('Bash')).toMatch(/Bash/)
  })

  it('leaves MCP tools to resource grants', () => {
    expect(
      permissionDenial(perms, {
        kind: 'tool_call',
        toolName: 'gh__create_issue',
        mcpServerId: 'gh',
      }),
    ).toBeNull()
    expect(
      permissionDenial(perms, { kind: 'tool_call', toolName: 'mcp__other__do', mcpServerId: null }),
    ).toBeNull()
  })

  it('strips disallowed built-in tool definitions only', () => {
    const tools = [{ name: 'Read' }, { name: 'Bash' }, { name: 'mcp__acl__gh__list' }, {}]
    expect(filterToolDefinitions(perms, tools)).toEqual([
      { name: 'Read' },
      { name: 'mcp__acl__gh__list' },
      {},
    ])
  })
})

describe('MCP access', () => {
  const resources = [row('res_gh', 'gh', ['list_*'])]
  const permissions = {
    models: [],
    builtinTools: [],
    mcp: { gh: ['get_issue'], linear: ['create_issue'] },
  }
  const access = mcpAccess(resources, permissions, undefined)

  it('combines resource grants and group MCP permissions', () => {
    expect(mcpToolAccess(access, 'gh', 'list_repos')).toEqual({
      allowed: true,
      resourceIds: ['res_gh'],
    })
    expect(mcpToolAccess(access, 'gh', 'get_issue')).toEqual({ allowed: true, resourceIds: [] })
    expect(mcpToolAccess(access, 'gh', 'delete_repo').allowed).toBe(false)
    expect(mcpToolAccess(access, 'linear', 'create_issue').allowed).toBe(true)
    expect(mcpToolAccess(access, 'linear', 'delete_issue').allowed).toBe(false)
  })

  it('hides servers nothing grants', () => {
    expect(mcpServerVisible(access, 'gh')).toBe(true)
    expect(mcpServerVisible(access, 'linear')).toBe(true)
    expect(mcpServerVisible(access, 'slack')).toBe(false)
  })

  it('keeps only the selected resources in a narrowed session', () => {
    const scoped = mcpAccess(resources, permissions, ['res_gh'])
    expect(mcpToolAccess(scoped, 'gh', 'list_repos').allowed).toBe(true)
    expect(mcpToolAccess(scoped, 'gh', 'get_issue').allowed).toBe(false)
    expect(mcpServerVisible(scoped, 'linear')).toBe(false)
  })
})

describe('rate limit rules', () => {
  const rule = (scope: RateLimitRule['scope'], target: string): RateLimitRule => ({
    id: `${scope}:${target}`,
    scope,
    target,
    limit: 10,
    windowSec: 60,
    per: 'user',
  })
  const rules = [
    rule('mcp', 'gh'),
    rule('tool', 'gh__create_issue'),
    rule('tool', '*'),
    rule('resource', 'read'),
  ]

  it('matches by server, tool and resource', () => {
    const ids = matchingRules(rules, {
      mcpServerId: 'gh',
      toolName: 'gh__create_issue',
      resourceIds: ['all'],
    }).map((r) => r.id)
    expect(ids).toEqual(['mcp:gh', 'tool:gh__create_issue', 'tool:*'])
    expect(
      matchingRules(rules, {
        mcpServerId: 'jira',
        toolName: 'jira__get',
        resourceIds: ['read'],
      }).map((r) => r.id),
    ).toEqual(['tool:*', 'resource:read'])
  })
})
