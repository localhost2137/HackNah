import {
  type BlockId,
  type BlockSpec,
  blockOf,
  blockOutput,
  type CheckType,
  type PolicyGraph,
  type PolicyNode,
  palette,
} from '@acl/shared'

export type Suggestion = {
  block: BlockSpec
  /** Why the block is demoted or unavailable here; empty otherwise. */
  reason: string
  disabled: boolean
  /** Listed up front. Everything else stays reachable under "Other elements". */
  recommended: boolean
}

const MAX_RECOMMENDED = 4

/** What follows a request that an earlier check flagged, whatever the block in between. */
const afterFlag: BlockId[] = ['block', 'approve_admin']

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
  const outputs = blockOf(node).outputs.length
  const paths = neighbours.map((next) => checksOnPaths(graph, next, direction, seen, memo))
  if (direction === 'after' && neighbours.length < outputs) paths.push(new Set())
  const result = paths.length ? intersection(paths) : new Set<CheckType>()
  if (node.type === 'check' && node.enabled) result.add(node.check.type)
  memo.set(id, result)
  return result
}

function nodeName(node: PolicyNode | undefined) {
  if (!node) return 'the next step'
  return (node.type === 'match' && node.label) || blockOf(node).label
}

/** Did the request leave an enabled check through a warning or failing output on the way here? */
function flaggedUpstream(graph: PolicyGraph, sourceId: string, handle: string): boolean {
  const edges = [{ source: sourceId, sourceHandle: handle }]
  const pending = [sourceId]
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of graph.edges.filter((e) => e.target === id)) {
      edges.push(edge)
      pending.push(edge.source)
    }
  }
  return edges.some((edge) => {
    const node = graph.nodes.find((n) => n.id === edge.source)
    if (node?.type !== 'check' || !node.enabled) return false
    const tone = blockOutput(node, edge.sourceHandle)?.tone
    return tone === 'bad' || tone === 'warn'
  })
}

/**
 * The blocks to offer after an output. Recommendations come from the `next` list the source
 * block declares for that output, minus checks the path already runs and outcomes that would
 * cut an existing connection.
 */
export function recommendSteps(graph: PolicyGraph, sourceId: string, handle: string): Suggestion[] {
  const source = graph.nodes.find((n) => n.id === sourceId)
  const output = source ? blockOutput(source, handle) : undefined
  const connection = graph.edges.find((e) => e.source === sourceId && e.sourceHandle === handle)
  const next = graph.nodes.find((n) => n.id === connection?.target)
  const before = checksOnPaths(graph, sourceId, 'before')
  const after = connection ? checksOnPaths(graph, connection.target, 'after') : new Set<CheckType>()

  const flagged = flaggedUpstream(graph, sourceId, handle)
  const declared = output?.next ?? []
  const common =
    flagged && output?.tone !== 'bad' && output?.tone !== 'warn'
      ? [...afterFlag, ...declared.filter((id) => id !== 'allow' && !afterFlag.includes(id))]
      : declared

  const choices = palette.map((block): Suggestion => {
    let reason = ''
    let disabled = false
    if (block.nodeType === 'check') {
      const check = block.id as CheckType
      if (before.has(check)) reason = 'Already checked on every path reaching this point.'
      else if (after.has(check))
        reason = `Already checked ahead${next?.type === 'check' && next.check.type === check ? ' in the next step' : ' on this branch'}.`
    } else if (block.through === null && connection) {
      disabled = true
      reason = `This branch continues to ${nodeName(next)}. Add an outcome on an unconnected output.`
    } else if (block.id === 'allow' && flagged) {
      reason = 'Would let this flagged request through without approval.'
    }
    return { block, reason, disabled, recommended: false }
  })

  const byId = new Map(choices.map((c) => [c.block.id, c]))
  const recommended = common
    .map((id) => byId.get(id))
    .filter((c): c is Suggestion => !!c && !c.disabled && !c.reason)
    .slice(0, MAX_RECOMMENDED)
  for (const choice of recommended) choice.recommended = true
  return [...recommended, ...choices.filter((c) => !c.recommended)]
}
