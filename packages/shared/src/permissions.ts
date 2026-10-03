import { globMatch } from './engine.ts'

/** What members of a group may use besides MCP resources, which are granted per resource. */
export type GroupPermissions = {
  /** Glob patterns over model ids, e.g. `claude-sonnet-*`. */
  models: string[]
  /** Glob patterns over Claude Code built-in tool names, e.g. `WebFetch` or `*`. */
  builtinTools: string[]
}

export const NO_PERMISSIONS: GroupPermissions = { models: [], builtinTools: [] }
export const ALL_PERMISSIONS: GroupPermissions = { models: ['*'], builtinTools: ['*'] }

/** Built-in tools Claude Code ships with, offered as suggestions in the dashboard. */
export const BUILTIN_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const

/** Group permissions are additive: a user may use whatever any of their groups allows. */
export function mergePermissions(all: GroupPermissions[]): GroupPermissions {
  const union = (pick: (p: GroupPermissions) => string[]) => [...new Set(all.flatMap(pick))]
  return { models: union((p) => p.models), builtinTools: union((p) => p.builtinTools) }
}

export function modelAllowed(p: GroupPermissions, model: string): boolean {
  return p.models.some((pattern) => globMatch(pattern, model))
}

/** MCP tools (`mcp__*`) are governed by resource grants, not by this list. */
export function isBuiltinTool(name: string): boolean {
  return !name.startsWith('mcp__')
}

export function builtinToolAllowed(p: GroupPermissions, name: string): boolean {
  return p.builtinTools.some((pattern) => globMatch(pattern, name))
}
