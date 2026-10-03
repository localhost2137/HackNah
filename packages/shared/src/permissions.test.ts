import { describe, expect, it } from 'vitest'
import {
  builtinToolAllowed,
  isBuiltinTool,
  mergePermissions,
  modelAllowed,
  NO_PERMISSIONS,
} from './permissions.ts'

describe('group permissions', () => {
  const merged = mergePermissions([
    { models: ['claude-haiku-*'], builtinTools: ['Read', 'Grep'] },
    { models: ['claude-sonnet-*', 'claude-haiku-*'], builtinTools: ['Bash'] },
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

  it('leaves MCP tools to resource grants', () => {
    expect(isBuiltinTool('Bash')).toBe(true)
    expect(isBuiltinTool('mcp__acl__github__create_issue')).toBe(false)
  })
})
