import { globMatch } from './engine.ts'

/** What members of a group may use. MCP tools may also be granted through resources. */
export type GroupPermissions = {
  /** Glob patterns over model ids, e.g. `claude-sonnet-*`. */
  models: string[]
  /** Glob patterns over Claude Code built-in tool names, e.g. `WebFetch` or `*`. */
  builtinTools: string[]
  /**
   * MCP servers the group sees, keyed by server id (`*` for every server), each with glob
   * patterns over its tool names. A server without an entry is invisible to the group.
   */
  mcp: Record<string, string[]>
}

export const NO_PERMISSIONS: GroupPermissions = { models: [], builtinTools: [], mcp: {} }
export const ALL_PERMISSIONS: GroupPermissions = {
  models: ['*'],
  builtinTools: ['*'],
  mcp: { '*': ['*'] },
}

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

/** Fills fields added after a group's permissions were stored. */
export function normalizePermissions(p: Partial<GroupPermissions>): GroupPermissions {
  return { models: p.models ?? [], builtinTools: p.builtinTools ?? [], mcp: p.mcp ?? {} }
}

/** Group permissions are additive: a user may use whatever any of their groups allows. */
export function mergePermissions(all: Partial<GroupPermissions>[]): GroupPermissions {
  const perms = all.map(normalizePermissions)
  const union = (lists: string[][]) => [...new Set(lists.flat())]
  const mcp: Record<string, string[]> = {}
  for (const p of perms)
    for (const [server, tools] of Object.entries(p.mcp))
      mcp[server] = union([mcp[server] ?? [], tools])
  return {
    models: union(perms.map((p) => p.models)),
    builtinTools: union(perms.map((p) => p.builtinTools)),
    mcp,
  }
}

export function modelAllowed(p: GroupPermissions, model: string): boolean {
  return p.models.some((pattern) => globMatch(pattern, model))
}

/** MCP tools (`mcp__*`) are governed by MCP permissions and resource grants, not by this list. */
export function isBuiltinTool(name: string): boolean {
  return !name.startsWith('mcp__')
}

export function builtinToolAllowed(p: GroupPermissions, name: string): boolean {
  return p.builtinTools.some((pattern) => globMatch(pattern, name))
}

function mcpPatterns(p: GroupPermissions, serverId: string): string[] {
  return [...(p.mcp['*'] ?? []), ...(p.mcp[serverId] ?? [])]
}

/** Whether the server is visible at all, i.e. at least some of its tools may be allowed. */
export function mcpServerAllowed(p: GroupPermissions, serverId: string): boolean {
  return mcpPatterns(p, serverId).length > 0
}

export function mcpToolAllowed(p: GroupPermissions, serverId: string, tool: string): boolean {
  return mcpPatterns(p, serverId).some((pattern) => globMatch(pattern, tool))
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
