import { globMatch } from './engine.ts'

/**
 * What members of a group may use. MCP tools are not listed here: a group gets them through the
 * resources granted to it.
 */
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

/** Fills fields added after a group's permissions were stored, and drops retired ones. */
export function normalizePermissions(p: Partial<GroupPermissions>): GroupPermissions {
  return { models: p.models ?? [], builtinTools: p.builtinTools ?? [] }
}

/** Group permissions are additive: a user may use whatever any of their groups allows. */
export function mergePermissions(all: Partial<GroupPermissions>[]): GroupPermissions {
  const perms = all.map(normalizePermissions)
  const union = (lists: string[][]) => [...new Set(lists.flat())]
  return {
    models: union(perms.map((p) => p.models)),
    builtinTools: union(perms.map((p) => p.builtinTools)),
  }
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

/** The tool patterns a resource holds for a server, including those it holds for every server. */
export function resourcePatterns(tools: Record<string, string[]>, serverId: string): string[] {
  return [...(tools['*'] ?? []), ...(tools[serverId] ?? [])]
}

export function resourceCoversTool(
  tools: Record<string, string[]>,
  serverId: string,
  tool: string,
): boolean {
  return resourcePatterns(tools, serverId).some((pattern) => globMatch(pattern, tool))
}

/**
 * A server's tool patterns with one tool allowed or forbidden. Forbidding a tool that a glob such
 * as `*` or `get_*` covers rewrites that glob into the other tools it matches today, so tools the
 * server adds later are no longer granted by it.
 */
export function withMcpTool(
  patterns: string[],
  tool: string,
  allowed: boolean,
  serverTools: string[],
): string[] {
  const covered = patterns.some((p) => globMatch(p, tool))
  if (allowed) return covered ? patterns : [...patterns, tool]
  const next = patterns.flatMap((p) =>
    !globMatch(p, tool)
      ? [p]
      : p === tool
        ? []
        : serverTools.filter((t) => t !== tool && globMatch(p, t)),
  )
  return [...new Set(next)]
}
