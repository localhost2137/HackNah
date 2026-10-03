import type { RateLimitRule } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { applySessionScope, globMatch, resourcesForTool } from './access.ts'
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
