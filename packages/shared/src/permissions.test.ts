import { describe, expect, it } from 'vitest'
import {
  builtinToolAllowed,
  isBuiltinTool,
  mcpServerAllowed,
  mcpToolAllowed,
  mergePermissions,
  modelAllowed,
  NO_PERMISSIONS,
  withMcpTool,
} from './permissions.ts'

describe('group permissions', () => {
  const merged = mergePermissions([
    { models: ['claude-haiku-*'], builtinTools: ['Read', 'Grep'], mcp: { gh: ['get_issue'] } },
    {
      models: ['claude-sonnet-*', 'claude-haiku-*'],
      builtinTools: ['Bash'],
      mcp: { gh: ['list_*'], linear: ['*'] },
    },
    // Stored before MCP permissions existed.
    { models: [], builtinTools: [] },
  ])

  it('unions every group', () => {
    expect(merged.models).toEqual(['claude-haiku-*', 'claude-sonnet-*'])
    expect(merged.builtinTools).toEqual(['Read', 'Grep', 'Bash'])
    expect(merged.mcp).toEqual({ gh: ['get_issue', 'list_*'], linear: ['*'] })
  })

  it('matches models and built-in tools by glob', () => {
    expect(modelAllowed(merged, 'claude-sonnet-4-5')).toBe(true)
    expect(modelAllowed(merged, 'claude-opus-4-1')).toBe(false)
    expect(builtinToolAllowed(merged, 'Bash')).toBe(true)
    expect(builtinToolAllowed(merged, 'WebFetch')).toBe(false)
    expect(modelAllowed(NO_PERMISSIONS, 'claude-haiku-4')).toBe(false)
  })

  it('hides MCP servers without an entry and allows only matching tools', () => {
    expect(mcpServerAllowed(merged, 'gh')).toBe(true)
    expect(mcpServerAllowed(merged, 'slack')).toBe(false)
    expect(mcpToolAllowed(merged, 'gh', 'get_issue')).toBe(true)
    expect(mcpToolAllowed(merged, 'gh', 'list_repos')).toBe(true)
    expect(mcpToolAllowed(merged, 'gh', 'create_issue')).toBe(false)
    expect(mcpToolAllowed(merged, 'linear', 'anything')).toBe(true)
    expect(mcpToolAllowed({ ...NO_PERMISSIONS, mcp: { '*': ['*'] } }, 'slack', 'post')).toBe(true)
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
