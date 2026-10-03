import {
  type CheckType,
  checkLabels,
  nodeOutputs,
  type PolicyGraph,
  type PolicyNode,
} from '@acl/shared'

export type PaletteItem =
  | { kind: 'match' }
  | { kind: 'check'; check: CheckType }
  | { kind: 'decision'; action: 'allow' | 'block' | 'require_approval' }

export const palette: { label: string; item: PaletteItem }[] = [
  { label: 'Route', item: { kind: 'match' } },
  ...(Object.keys(checkLabels) as CheckType[]).map((check) => ({
    label: checkLabels[check],
    item: { kind: 'check' as const, check },
  })),
  { label: 'Allow', item: { kind: 'decision', action: 'allow' } },
  { label: 'Require approval', item: { kind: 'decision', action: 'require_approval' } },
  { label: 'Block', item: { kind: 'decision', action: 'block' } },
]

export type Suggestion = (typeof palette)[number] & {
  reason: string
  score: number
  disabled: boolean
  recommended: boolean
}
const intersection = (sets: Set<CheckType>[]) =>
  new Set([...(sets[0] ?? [])].filter((type) => sets.every((set) => set.has(type))))

/** Checks guaranteed on every incoming path. Parallel branches don't count as duplicates. */
function checksOnPaths(
  graph: PolicyGraph,
  id: string,
  direction: 'before' | 'after',
  visited = new Set<string>(),
  memo = new Map<string, Set<CheckType>>(),
): Set<CheckType> {
  if (visited.has(id)) return new Set()
  const cached = memo.get(id)
  if (cached) return cached
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return new Set()
  const seen = new Set(visited).add(id)
  const neighbours = graph.edges
    .filter((e) => (direction === 'before' ? e.target === id : e.source === id))
    .map((e) => (direction === 'before' ? e.source : e.target))
  // An open output is also an execution path: downstream checks aren't guaranteed there.
  const outputs = nodeOutputs(node).length
  const paths = neighbours.map((next) => checksOnPaths(graph, next, direction, seen, memo))
  if (direction === 'after' && neighbours.length < outputs) paths.push(new Set())
  const result = paths.length ? intersection(paths) : new Set<CheckType>()
  if (node.type === 'check' && node.enabled) result.add(node.check.type)
  memo.set(id, result)
  return result
}

function nodeName(node: PolicyNode | undefined) {
  return node?.type === 'check'
    ? checkLabels[node.check.type]
    : node?.type === 'match'
      ? node.label || 'Route'
      : node?.type === 'decision'
        ? node.action === 'require_approval'
          ? 'Require approval'
          : node.action === 'allow'
            ? 'Allow'
            : 'Block'
        : 'the next step'
}

export function recommendSteps(graph: PolicyGraph, sourceId: string, handle: string): Suggestion[] {
  const source = graph.nodes.find((n) => n.id === sourceId)
  const connection = graph.edges.find((e) => e.source === sourceId && e.sourceHandle === handle)
  const next = graph.nodes.find((n) => n.id === connection?.target)
  const before = checksOnPaths(graph, sourceId, 'before')
  const after = connection ? checksOnPaths(graph, connection.target, 'after') : new Set<CheckType>()
  const contextEdges = [{ source: sourceId, sourceHandle: handle }]
  const pending = [sourceId]
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of graph.edges.filter((e) => e.target === id)) {
      contextEdges.push(edge)
      pending.push(edge.source)
    }
  }
  const failed = contextEdges.some((edge) => {
    const node = graph.nodes.find((n) => n.id === edge.source)
    return (
      node?.type === 'check' &&
      node.enabled &&
      ['fail', 'mismatch', 'error'].includes(edge.sourceHandle)
    )
  })
  const newDevice = contextEdges.some((edge) => {
    const node = graph.nodes.find((n) => n.id === edge.source)
    return (
      node?.type === 'check' &&
      node.enabled &&
      node.check.type === 'fingerprint' &&
      edge.sourceHandle === 'new'
    )
  })
  const atStart = source?.type === 'trigger'
  const ranked = palette
    .map(({ label, item }): Suggestion => {
      let score = 0
      let reason = ''
      let disabled = false
      if (item.kind === 'check') {
        if (before.has(item.check)) reason = 'Already checked on every path reaching this point.'
        else if (after.has(item.check))
          reason = `Already checked ahead${next?.type === 'check' && next.check.type === item.check ? ' in the next step' : ' on this branch'}.`
        else if (item.check === 'fingerprint') {
          score = atStart ? 100 : failed ? 20 : 75
          reason = 'Verify the device before inspecting its request.'
        } else if (item.check === 'keywords') {
          score = failed ? 35 : 95
          reason = newDevice
            ? 'Inspect the request before asking for device approval.'
            : 'Catch dangerous commands before more expensive checks.'
        } else if (item.check === 'judge') {
          score = failed
            ? source?.type === 'check' && source.check.type === 'keywords'
              ? 65
              : 30
            : atStart
              ? 55
              : 85
          reason = failed
            ? 'Assess the flagged request with a different kind of check.'
            : 'Assess risks that simple keyword rules can miss.'
        } else {
          score = failed || newDevice ? 25 : atStart ? 50 : 80
          reason = 'Protect secrets and personal data before forwarding.'
        }
      } else if (item.kind === 'match') {
        score = source?.type === 'match' ? 45 : 70
        reason =
          source?.type === 'match'
            ? 'Add a more specific condition within this branch.'
            : 'Apply different rules by tool, team, or request type.'
      } else if (connection) {
        disabled = true
        reason = `This branch continues to ${nodeName(next)}. Add an outcome on an unconnected output.`
      } else if (item.action === 'block') {
        score = failed ? 100 : 25
        reason = failed
          ? 'Stop a request that failed this check.'
          : 'End this branch by denying the request.'
      } else if (item.action === 'require_approval') {
        score = newDevice ? 100 : failed ? 90 : 45
        reason = newDevice
          ? 'Ask an administrator to review the new device.'
          : failed
            ? 'Let an administrator review the flagged request.'
            : 'Require a human decision before continuing.'
      } else {
        score = failed || newDevice || atStart ? 0 : before.size ? 90 : 40
        reason =
          failed || newDevice
            ? 'Would let this flagged request through without approval.'
            : atStart
              ? 'Would forward requests without running any checks.'
              : 'Finish this branch after its checks have passed.'
      }
      return { label, item, score, reason, disabled, recommended: false }
    })
    .sort(
      (a, b) =>
        Number(a.disabled) - Number(b.disabled) ||
        b.score - a.score ||
        a.label.localeCompare(b.label),
    )
  let count = 0
  return ranked.map((choice) => ({
    ...choice,
    recommended: !choice.disabled && choice.score >= 60 && count++ < 3,
  }))
}
