import type { CheckResult } from './events.ts'
import type { PolicyGraph } from './guardrail.ts'

/** The step id the engine records when a path ends in the guardrail's fallback. */
export const FALLBACK_STEP = '(fallback)'

export type GuardrailPath = {
  /** Every node the request went through, the trigger included. */
  nodes: Set<string>
  /** What was recorded at each visited node, with its position on the path (from 1). */
  steps: Map<string, { check: CheckResult; order: number }>
  /** Ids of the edges the request followed. */
  edges: Set<string>
  /** The node the path stopped at: the decision, or the last node before a fallback. */
  endNodeId: string | null
  /** Set when the path ended in the fallback: a check errored or an output led nowhere. */
  fallback: CheckResult | null
  /** Recorded steps that are not nodes of this graph, e.g. from before a graph was converted. */
  unmatched: CheckResult[]
}

/**
 * The path one event took through one guardrail version, from the checks stored on the event.
 * `guardrailId` picks that guardrail's checks out of an event that ran several.
 */
export function guardrailPath(
  graph: PolicyGraph,
  checks: CheckResult[],
  guardrailId?: string,
): GuardrailPath {
  const own = guardrailId ? checks.filter((c) => c.guardrailId === guardrailId) : checks
  const ids = new Set(graph.nodes.map((n) => n.id))
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  const path: GuardrailPath = {
    nodes: new Set(),
    steps: new Map(),
    edges: new Set(),
    endNodeId: null,
    fallback: null,
    unmatched: [],
  }
  if (own.length === 0) return path

  const taken = (source: string, handle: string | undefined) => {
    if (!handle) return
    const edge = graph.edges.find((e) => e.source === source && e.sourceHandle === handle)
    if (edge) path.edges.add(edge.id)
  }
  if (trigger) {
    path.nodes.add(trigger.id)
    path.endNodeId = trigger.id
    taken(trigger.id, 'next')
  }
  for (const check of own) {
    if (check.stepId === FALLBACK_STEP) {
      path.fallback = check
      continue
    }
    if (!ids.has(check.stepId)) {
      path.unmatched.push(check)
      continue
    }
    path.nodes.add(check.stepId)
    path.steps.set(check.stepId, { check, order: path.steps.size + 1 })
    path.endNodeId = check.stepId
    taken(check.stepId, check.branch)
  }
  return path
}
