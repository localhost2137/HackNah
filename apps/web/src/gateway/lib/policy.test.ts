import { type LimitRule, limitApplies, limitRule } from '@acl/shared'
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

type Row = Parameters<typeof resourcesForTool>[0][number]
const row = (id: string, tools: Record<string, string[]>) =>
  ({ id, tools, name: id }) as unknown as Row

describe('resource matching', () => {
  const resources = [
    row('read', { gh: ['get_*', 'list_*', 'search_*'] }),
    row('all', { gh: ['*'] }),
    row('jira', { jira: ['*'] }),
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
    // Handing a task to a subagent is an agent message, but still a tool the group must allow.
    expect(permissionDenial(perms, { kind: 'agent_message', toolName: 'Task' })).toMatch(/Task/)
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
  // One resource spans two servers; another covers every server for one kind of tool.
  const resources = [
    row('res_work', { gh: ['list_*'], linear: ['create_issue'] }),
    row('res_search', { '*': ['search_*'] }),
  ]
  const access = mcpAccess(resources, false, undefined)

  it('grants what the resources hold, across servers', () => {
    expect(mcpToolAccess(access, 'gh', 'list_repos')).toEqual({
      allowed: true,
      resourceIds: ['res_work'],
    })
    expect(mcpToolAccess(access, 'linear', 'create_issue').allowed).toBe(true)
    expect(mcpToolAccess(access, 'linear', 'delete_issue').allowed).toBe(false)
    expect(mcpToolAccess(access, 'gh', 'delete_repo').allowed).toBe(false)
    expect(mcpToolAccess(access, 'slack', 'search_messages')).toEqual({
      allowed: true,
      resourceIds: ['res_search'],
    })
  })

  it('shows a server when a resource holds any of its tools', () => {
    expect(mcpServerVisible(access, 'gh')).toBe(true)
    expect(mcpServerVisible(access, 'linear')).toBe(true)
    expect(mcpServerVisible(mcpAccess([resources[0]!], false, undefined), 'slack')).toBe(false)
  })

  it('lets admins call every tool, unless the session is narrowed', () => {
    const admin = mcpAccess(resources, true, undefined)
    expect(mcpToolAccess(admin, 'gh', 'delete_repo')).toEqual({ allowed: true, resourceIds: [] })
    expect(mcpServerVisible(admin, 'anything')).toBe(true)
    const narrowed = mcpAccess(resources, true, ['res_work'])
    expect(mcpToolAccess(narrowed, 'gh', 'delete_repo').allowed).toBe(false)
    expect(mcpToolAccess(narrowed, 'gh', 'list_repos').allowed).toBe(true)
  })

  it('keeps only the selected resources in a narrowed session', () => {
    const scoped = mcpAccess(resources, false, ['res_work'])
    expect(mcpToolAccess(scoped, 'gh', 'list_repos').allowed).toBe(true)
    expect(mcpToolAccess(scoped, 'slack', 'search_messages').allowed).toBe(false)
    expect(mcpServerVisible(scoped, 'slack')).toBe(false)
  })
})

describe('limit rules', () => {
  const rule = (scope: LimitRule['scope'], target: string): LimitRule =>
    limitRule.parse({ id: `${scope}:${target}`, scope, target, limit: 10, windowSec: 60 })
  const rules = [
    rule('mcp', 'gh'),
    rule('tool', 'gh__create_issue'),
    rule('tool', '*'),
    rule('resource', 'read'),
    rule('model', '*'),
  ]
  const principal = { orgId: 'org', userId: 'u', groupIds: [] }
  const matching = (mcpServerId: string, toolName: string, resourceIds: string[]) =>
    rules
      .filter((r) =>
        limitApplies(r, { scope: 'tool', mcpServerId, toolName, resourceIds }, principal),
      )
      .map((r) => r.id)

  it('matches by server, tool and resource', () => {
    expect(matching('gh', 'gh__create_issue', ['all'])).toEqual([
      'mcp:gh',
      'tool:gh__create_issue',
      'tool:*',
    ])
    expect(matching('jira', 'jira__get', ['read'])).toEqual(['tool:*', 'resource:read'])
  })
})
