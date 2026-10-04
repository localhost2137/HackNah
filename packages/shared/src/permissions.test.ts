import { describe, expect, it } from 'vitest'
import {
  builtinToolAllowed,
  isBuiltinTool,
  mergePermissions,
  modelAllowed,
  NO_PERMISSIONS,
  normalizePermissions,
  resourceCoversTool,
  resourcePatterns,
  withMcpTool,
} from './permissions.ts'

describe('group permissions', () => {
  const merged = mergePermissions([
    { models: ['claude-haiku-*'], builtinTools: ['Read', 'Grep'] },
    { models: ['claude-sonnet-*', 'claude-haiku-*'], builtinTools: ['Bash'] },
    { models: [], builtinTools: [] },
  ])

  it('unions every group', () => {
    expect(merged.models).toEqual(['claude-haiku-*', 'claude-sonnet-*'])
    expect(merged.builtinTools).toEqual(['Read', 'Grep', 'Bash'])
  })

  it('matches models and built-in tools by glob', () => {
    expect(modelAllowed(merged, 'claude-sonnet-4-5')).toBe(true)
    expect(modelAllowed(merged, 'claude-opus-4-1')).toBe(false)
    expect(builtinToolAllowed(merged, 'Bash')).toBe(true)
    expect(builtinToolAllowed(merged, 'WebFetch')).toBe(false)
    expect(modelAllowed(NO_PERMISSIONS, 'claude-haiku-4')).toBe(false)
  })

  it('drops the MCP section groups used to carry', () => {
    const stored = { models: ['*'], builtinTools: [], mcp: { gh: ['*'] } }
    expect(normalizePermissions(stored)).toEqual({ models: ['*'], builtinTools: [] })
  })

  it('matches the tools a resource holds per server, and for every server', () => {
    const tools = { gh: ['get_issue', 'list_*'], linear: ['*'] }
    expect(resourceCoversTool(tools, 'gh', 'get_issue')).toBe(true)
    expect(resourceCoversTool(tools, 'gh', 'list_repos')).toBe(true)
    expect(resourceCoversTool(tools, 'gh', 'create_issue')).toBe(false)
    expect(resourceCoversTool(tools, 'linear', 'anything')).toBe(true)
    expect(resourceCoversTool(tools, 'slack', 'post')).toBe(false)
    expect(resourcePatterns(tools, 'slack')).toEqual([])
    expect(resourceCoversTool({ '*': ['get_*'] }, 'slack', 'get_user')).toBe(true)
  })

  it('tells built-in tools from MCP tools', () => {
    expect(isBuiltinTool('Bash')).toBe(true)
    expect(isBuiltinTool('mcp__acl__github__create_issue')).toBe(false)
  })

  it('allows or forbids a single MCP tool', () => {
    const tools = ['get_issue', 'list_issues', 'create_issue']
    expect(withMcpTool([], 'get_issue', true, tools)).toEqual(['get_issue'])
    expect(withMcpTool(['get_*'], 'get_issue', true, tools)).toEqual(['get_*'])
    expect(withMcpTool(['get_issue', 'list_*'], 'get_issue', false, tools)).toEqual(['list_*'])
    expect(withMcpTool(['*'], 'create_issue', false, tools)).toEqual(['get_issue', 'list_issues'])
    expect(withMcpTool(['get_issue'], 'get_issue', false, tools)).toEqual([])
  })
})
