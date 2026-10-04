import { Document, isMap, isSeq, LineCounter, parseDocument, visit } from 'yaml'
import { z } from 'zod'
import { kindLabels } from './events.ts'
import { limitRule, limitRuleIssue, modelEntry } from './limits.ts'
import { type PolicyGraph, policyGraph, validateGraph } from './workflow.ts'

/**
 * The whole policy of an instance as one file: workflows, limits and the model catalog. It is
 * exported from and applied to a running instance, so a policy can be reviewed, versioned and
 * moved between instances. Groups are referred to by name, never by id, and API keys are never
 * part of it.
 */

export const POLICY_FILE_VERSION = 1

/** The name the default group can always be referred to by, whatever it is called. */
export const ALL_MEMBERS = 'All members'

/**
 * Lays out nodes written without a `position`: one column per step from the start node, one row
 * per branch, as the editor would place them.
 */
export function withLayout(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const graph = raw as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(graph.nodes)) return raw
  const nodes = graph.nodes as { id?: unknown; type?: unknown; position?: unknown }[]
  if (nodes.every((n) => n && typeof n === 'object' && n.position)) return raw
  const edges = (Array.isArray(graph.edges) ? graph.edges : []) as {
    source?: unknown
    target?: unknown
  }[]
  const depth = new Map<unknown, number>()
  const start = nodes.find((n) => n?.type === 'trigger')
  const queue: unknown[] = start ? [start.id] : []
  if (start) depth.set(start.id, 0)
  while (queue.length) {
    const id = queue.shift()
    for (const e of edges)
      if (e.source === id && !depth.has(e.target)) {
        depth.set(e.target, depth.get(id)! + 1)
        queue.push(e.target)
      }
  }
  const rows = new Map<number, number>()
  return {
    ...graph,
    nodes: nodes.map((n) => {
      if (!n || typeof n !== 'object' || n.position) return n
      const col = depth.get(n.id) ?? Math.max(0, ...depth.values()) + 1
      const row = rows.get(col) ?? 0
      rows.set(col, row + 1)
      return { ...n, position: { x: col * 340, y: row * 200 } }
    }),
  }
}

export const policyWorkflow = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().default(null),
  enabled: z.boolean().default(true),
  /** Groups (by name) whose members this workflow runs for. Empty means every member. */
  groups: z.array(z.string().min(1)).default([]),
  /**
   * The graph. Nodes may leave out `position`; a Usage limit block names its limit by the
   * limit's `name` here, not by id.
   */
  definition: z.preprocess(withLayout, policyGraph),
})
export type PolicyWorkflow = z.infer<typeof policyWorkflow>

export const policyLimit = limitRule.omit({ id: true, groupId: true }).extend({
  /** The group (by name) for `group_member` and `group_total`. */
  group: z.string().min(1).nullable().default(null),
  enabled: z.boolean().default(true),
})
export type PolicyLimit = z.infer<typeof policyLimit>

export const policyModel = modelEntry.omit({ id: true })
export type PolicyModel = z.infer<typeof policyModel>

export const policyFile = z.object({
  version: z.literal(POLICY_FILE_VERSION),
  /** Where known attack signatures are fetched from, for instances that use the feed. */
  signatureFeedUrl: z.string().optional(),
  /** In order: the order workflows are listed and their steps appear in events. */
  workflows: z.array(policyWorkflow).default([]),
  limits: z.array(policyLimit).default([]),
  /** In routing order: the first entry whose pattern matches a model id serves it. */
  models: z.array(policyModel).default([]),
})
export type PolicyFile = z.infer<typeof policyFile>

/**
 * How a limit is recognised across instances: by its name, or for an unnamed limit by what it
 * counts and for whom.
 */
export function limitKey(l: PolicyLimit): string {
  return (
    l.name ||
    `${l.measure} ${l.scope}:${l.target} per ${l.per}${l.group ? `:${l.group}` : ''} / ${l.windowSec}s`
  )
}

/** Problems the schema can't see: duplicates, invalid limits, workflows that can't publish. */
export function policyIssues(file: PolicyFile): string[] {
  const issues: string[] = []
  const dupes = (label: string, keys: string[]) => {
    const seen = new Set<string>()
    keys.forEach((key, i) => {
      if (seen.has(key)) issues.push(`${label}[${i}]: "${key}" appears more than once`)
      seen.add(key)
    })
  }
  dupes(
    'workflows',
    file.workflows.map((w) => w.name),
  )
  dupes('limits', file.limits.map(limitKey))
  dupes(
    'models',
    file.models.map((m) => m.pattern),
  )
  file.workflows.forEach((w, i) => {
    for (const issue of validateGraph(w.definition))
      if (issue.level === 'error')
        issues.push(
          `workflows[${i}] "${w.name}": ${issue.message}${issue.nodeId ? ` (node ${issue.nodeId})` : ''}`,
        )
  })
  const limitNames = new Set(file.limits.map(limitKey))
  file.workflows.forEach((w, i) => {
    mapLimitRefs(w.definition, (ref) => {
      if (!limitNames.has(ref))
        issues.push(
          `workflows[${i}] "${w.name}": Usage limit block refers to "${ref}", which is not in limits`,
        )
      return ref
    })
  })
  file.limits.forEach((l, i) => {
    const issue = limitRuleIssue({ ...l, groupId: l.group })
    if (issue) issues.push(`limits[${i}] "${limitKey(l)}": ${issue}`)
  })
  return issues
}

export type ParsedPolicy = { ok: true; file: PolicyFile } | { ok: false; errors: string[] }

/**
 * Parses and validates a policy file. Every error names where it is: the line and the path,
 * e.g. `line 42, workflows[1].definition.fallback: Invalid option`.
 */
export function parsePolicyYaml(text: string): ParsedPolicy {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false })
  if (doc.errors.length)
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const pos = lineCounter.linePos(e.pos[0])
        return `line ${pos.line}: ${e.message.split('\n')[0]}`
      }),
    }
  const parsed = policyFile.safeParse(doc.toJS())
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.filter((p) => typeof p !== 'symbol') as (string | number)[]
        const line = lineOf(doc, lineCounter, path)
        return `${line ? `line ${line}, ` : ''}${formatPath(path) || '(top level)'}: ${issue.message}`
      }),
    }
  const issues = policyIssues(parsed.data)
  return issues.length ? { ok: false, errors: issues } : { ok: true, file: parsed.data }
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (out, p) => (typeof p === 'number' ? `${out}[${p}]` : out ? `${out}.${p}` : p),
    '',
  )
}

/** The line of the deepest node along `path` that exists in the document. */
function lineOf(doc: Document, lc: LineCounter, path: (string | number)[]): number | null {
  for (let n = path.length; n >= 0; n--) {
    const node = doc.getIn(path.slice(0, n), true) as
      | { range?: [number, number, number] }
      | undefined
    if (node?.range) return lc.linePos(node.range[0]).line
  }
  return null
}

const header = `Hack?Nah! policy file.

Apply with \`pnpm policy:apply <file>\` or Settings > Policy file > Import. Applying publishes a
new version of every workflow whose graph changed; in replace mode, workflows, limits and models
missing from this file are disabled, never deleted. API keys are never exported: set them on the
Models page after importing.`

const sectionComments: Record<string, string> = {
  signatureFeedUrl: ' Where known attack signatures are fetched from (optional).',
  workflows: `
 Workflows. Every enabled workflow whose start node runs on the request's stage runs, and the
 strictest outcome wins: block over approval over allow. A workflow whose path ends in skip does
 not count. A start node without stages runs on every stage: model_request, tool_call,
 tool_result, model_output and agent_message.
   groups:     group names the workflow runs for; empty means every member.
   definition: the graph. nodes are trigger (start: stages), condition (one question about the
               request: field + values; outputs yes / no), check and decision (allow, block,
               require_approval, skip) blocks. edges connect a node's output (sourceHandle) to
               the next node: chain yes into the next condition for AND, no for OR; a node may
               have several incoming edges. fallback decides when an output is not connected or
               a check fails (allow or block).`,
  limits: `
 Limits, checked at the gateway before workflows run.
   measure:   requests | concurrent | tokens | cost (USD) | gpu_seconds
   scope:     model | mcp | tool | resource | guardrails (the judge's own calls)
   target:    model or tool glob, MCP server id or resource id; * for anything
   per:       user | group_member | group_total | org   (group: a group name, or "${ALL_MEMBERS}")
   action:    block | warn (allow and flag) | workflow (a Usage limit block decides)
   warnAtPct: percent of the limit from which requests count as near the limit`,
  models: `
 Model catalog, in routing order: the first enabled entry whose pattern matches serves the model.
 With any entry here, models outside the catalog are refused.
   kind:      external (priced per token) | local (priced per GPU-hour)
   apiFormat: anthropic (passed through) | openai (chat completions, translated)
   baseUrl:   empty for the gateway's default upstream (OpenRouter)
   prices:    USD per million tokens; cache write/read for prompt caching`,
}

function workflowComment(w: PolicyWorkflow): string {
  const trigger = w.definition.nodes.find((n) => n.type === 'trigger')
  const stages = trigger?.type === 'trigger' ? trigger.stages.map((k) => kindLabels[k]) : []
  const who = w.groups.length ? w.groups.join(', ') : 'every member'
  return ` ${stages.length ? stages.join(', ') : 'Any stage'} · ${who}${w.enabled ? '' : ' · disabled'}`
}

/** The policy as documented YAML: a header, a comment per section and per workflow. */
export function policyToYaml(file: PolicyFile): string {
  const doc = new Document(file)
  doc.commentBefore = header
    .split('\n')
    .map((l) => ` ${l}`)
    .join('\n')
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const key = String((pair.key as { value?: unknown }).value)
      const comment = sectionComments[key]
      if (comment) {
        const node = pair.key as { commentBefore?: string; spaceBefore?: boolean }
        node.commentBefore = comment.replace(/^\n/, '')
        node.spaceBefore = true
      }
      if (key === 'workflows' && isSeq(pair.value))
        pair.value.items.forEach((item, i) => {
          const w = file.workflows[i]
          if (w) (item as { commentBefore?: string }).commentBefore = workflowComment(w)
        })
    }
  }
  // Positions and edges on one line each keep the graphs readable.
  visit(doc, {
    Pair(_, pair) {
      const key = (pair.key as { value?: unknown }).value
      if (key === 'position' && isMap(pair.value)) pair.value.flow = true
      if (key === 'edges' && isSeq(pair.value))
        for (const edge of pair.value.items) if (isMap(edge)) edge.flow = true
      if (
        (key === 'values' || key === 'groups' || key === 'pii' || key === 'require') &&
        isSeq(pair.value)
      )
        pair.value.flow = true
    },
  })
  return doc.toString({ lineWidth: 100 })
}

export type PolicyChange = {
  kind: 'workflow' | 'limit' | 'model'
  name: string
  action: 'create' | 'update' | 'disable' | 'unchanged'
  /** What changes, for an update. */
  fields?: string[]
}

/** JSON with sorted keys, so two values compare equal whatever order their keys came in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

function changedFields<T extends Record<string, unknown>>(a: T, b: T, keys: (keyof T)[]): string[] {
  return keys.filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k])).map(String)
}

/** The graph without node positions: moving a node in the editor is not a policy change. */
export function graphLogic(graph: PolicyGraph): unknown {
  return { ...graph, nodes: graph.nodes.map(({ position: _, ...n }) => n) }
}

/**
 * What applying `next` to an instance whose policy is `current` would do. In `replace` mode
 * whatever `next` leaves out is disabled; in `merge` mode it is left alone.
 */
export function diffPolicy(
  current: PolicyFile,
  next: PolicyFile,
  mode: 'replace' | 'merge',
): PolicyChange[] {
  const changes: PolicyChange[] = []

  /** Where an entry sits among the entries both lists have: moving others around is no change. */
  const rank = <T>(list: T[], other: T[], key: (x: T) => string, item: T) => {
    const shared = new Set(other.map(key))
    return list.filter((x) => shared.has(key(x))).findIndex((x) => key(x) === key(item))
  }

  const section = <T extends { enabled: boolean }>(
    kind: PolicyChange['kind'],
    from: T[],
    to: T[],
    key: (x: T) => string,
    fields: (a: T, b: T) => string[],
  ) => {
    const existing = new Map(from.map((x) => [key(x), x]))
    for (const item of to) {
      const before = existing.get(key(item))
      if (!before) {
        changes.push({ kind, name: key(item), action: 'create' })
        continue
      }
      const diff = fields(before, item)
      changes.push(
        diff.length
          ? { kind, name: key(item), action: 'update', fields: diff }
          : { kind, name: key(item), action: 'unchanged' },
      )
    }
    if (mode === 'replace') {
      const kept = new Set(to.map(key))
      for (const item of from)
        if (!kept.has(key(item)) && item.enabled)
          changes.push({ kind, name: key(item), action: 'disable' })
    }
  }

  section(
    'workflow',
    current.workflows,
    next.workflows,
    (w) => w.name,
    (a, b) => {
      const fields = changedFields(a, b, ['description', 'enabled', 'groups'])
      if (canonicalJson(graphLogic(a.definition)) !== canonicalJson(graphLogic(b.definition)))
        fields.push('definition')
      const name = (w: PolicyWorkflow) => w.name
      if (
        rank(current.workflows, next.workflows, name, a) !==
        rank(next.workflows, current.workflows, name, b)
      )
        fields.push('position')
      return fields
    },
  )
  section('limit', current.limits, next.limits, limitKey, (a, b) =>
    changedFields(a, b, Object.keys(policyLimit.shape) as (keyof PolicyLimit)[]),
  )
  section(
    'model',
    current.models,
    next.models,
    (m) => m.pattern,
    (a, b) => {
      const fields = changedFields(a, b, Object.keys(policyModel.shape) as (keyof PolicyModel)[])
      const pattern = (m: PolicyModel) => m.pattern
      if (
        rank(current.models, next.models, pattern, a) !==
        rank(next.models, current.models, pattern, b)
      )
        fields.push('position')
      return fields
    },
  )
  return changes
}

/** The graph with every Usage limit block's limit reference passed through `map`. */
export function mapLimitRefs(graph: PolicyGraph, map: (ref: string) => string): PolicyGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === 'check' && n.check.type === 'limit' && n.check.limitId
        ? { ...n, check: { ...n.check, limitId: map(n.check.limitId) } }
        : n,
    ),
  }
}

/** What an instance holds, as `toPolicyFile` needs it. Ids are mapped to names here. */
export type PolicyState = {
  groups: { id: string; name: string; isDefault: boolean }[]
  workflows: {
    name: string
    description: string | null
    enabled: boolean
    groupIds: string[]
    /** The published graph; workflows never published are left out. */
    definition: PolicyGraph | null
  }[]
  limits: (PolicyLimit & { id: string; groupId: string | null })[]
  models: PolicyModel[]
  signatureFeedUrl?: string
}

export function groupNameOf(groups: PolicyState['groups'], id: string | null): string | null {
  if (!id) return null
  const g = groups.find((x) => x.id === id)
  return g ? (g.isDefault ? ALL_MEMBERS : g.name) : null
}

/** An instance's current policy, in workflow and routing order. */
export function toPolicyFile(state: PolicyState): PolicyFile {
  const limitNames = new Map(
    state.limits.map((l) => [
      l.id,
      limitKey({ ...l, group: groupNameOf(state.groups, l.groupId) }),
    ]),
  )
  return {
    version: POLICY_FILE_VERSION,
    ...(state.signatureFeedUrl ? { signatureFeedUrl: state.signatureFeedUrl } : {}),
    workflows: state.workflows
      .filter((w) => w.definition)
      .map((w) => ({
        name: w.name,
        description: w.description,
        enabled: w.enabled,
        groups: w.groupIds
          .map((id) => groupNameOf(state.groups, id))
          .filter((n): n is string => n !== null),
        definition: mapLimitRefs(w.definition!, (id) => limitNames.get(id) ?? id),
      })),
    limits: state.limits.map(({ id: _id, groupId, group: _, ...l }) => ({
      ...l,
      group: groupNameOf(state.groups, groupId),
    })),
    models: state.models,
  }
}

/**
 * Group ids for the names a file uses. "All members" (or the default group's own name) is the
 * default group. Returns the names no group has.
 */
export function resolveGroups(
  groups: PolicyState['groups'],
  file: PolicyFile,
): { ids: Map<string, string>; unknown: string[] } {
  const ids = new Map<string, string>()
  for (const g of groups) {
    ids.set(g.name, g.id)
    if (g.isDefault) ids.set(ALL_MEMBERS, g.id)
  }
  const used = [
    ...file.workflows.flatMap((w) => w.groups),
    ...file.limits.map((l) => l.group).filter((g): g is string => g !== null),
  ]
  return { ids, unknown: [...new Set(used.filter((n) => !ids.has(n)))] }
}
