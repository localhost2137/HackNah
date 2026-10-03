import { z } from 'zod'
import { eventKind } from './events.ts'

export const fingerprintCheck = z.object({ type: z.literal('fingerprint') })

export const keywordsCheck = z.object({
  type: z.literal('keywords'),
  patterns: z.array(z.string().min(1)).default([]),
  mode: z.enum(['substring', 'regex']).default('substring'),
  caseSensitive: z.boolean().default(false),
})

export const judgeCheck = z.object({
  type: z.literal('judge'),
  /** OpenAI-compatible chat completions endpoint. */
  endpoint: z.url(),
  model: z.string().min(1),
  /** Risk score in [0, 1] at or above which the check fails. */
  threshold: z.number().min(0).max(1).default(0.7),
  timeoutMs: z.number().int().min(100).max(30_000).default(8000),
  instructions: z.string().default(''),
})

export const piiKind = z.enum(['email', 'phone', 'iban', 'credit_card', 'ipv4', 'pesel'])
export type PiiKind = z.infer<typeof piiKind>

export const redactCheck = z.object({
  type: z.literal('redact'),
  secrets: z.boolean().default(true),
  pii: z.array(piiKind).default(['email', 'phone', 'iban', 'credit_card']),
})
export type RedactConfig = z.infer<typeof redactCheck>

export const checkConfig = z.discriminatedUnion('type', [
  fingerprintCheck,
  keywordsCheck,
  judgeCheck,
  redactCheck,
])
export type CheckConfig = z.infer<typeof checkConfig>
export type CheckType = CheckConfig['type']
export type JudgeCheck = z.infer<typeof judgeCheck>

const patterns = z.array(z.string().min(1))

export const condition = z.discriminatedUnion('field', [
  z.object({ field: z.literal('kind'), values: z.array(eventKind) }),
  z.object({ field: z.literal('mcpServer'), values: z.array(z.string()) }),
  /** Glob patterns (`*` wildcard) on the tool name, e.g. `delete_*` or `Bash`. */
  z.object({ field: z.literal('tool'), values: patterns }),
  z.object({ field: z.literal('resource'), values: z.array(z.string()) }),
  z.object({ field: z.literal('group'), values: z.array(z.string()) }),
  z.object({
    field: z.literal('deviceStatus'),
    values: z.array(z.enum(['trusted', 'new', 'mismatch'])),
  }),
  /** Glob patterns on the model id. */
  z.object({ field: z.literal('model'), values: patterns }),
])
export type Condition = z.infer<typeof condition>
export type ConditionField = Condition['field']

export const decisionAction = z.enum(['allow', 'block', 'require_approval'])
export type DecisionAction = z.infer<typeof decisionAction>

const position = z.object({ x: z.number(), y: z.number() })
const nodeBase = { id: z.string().min(1).max(64), position }

export const triggerNode = z.object({ ...nodeBase, type: z.literal('trigger') })

export const matchNode = z.object({
  ...nodeBase,
  type: z.literal('match'),
  label: z.string().max(80).default(''),
  mode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(condition).default([]),
})

export const checkNode = z.object({
  ...nodeBase,
  type: z.literal('check'),
  /** A disabled check is skipped and follows its `pass` output. */
  enabled: z.boolean().default(true),
  check: checkConfig,
})

export const decisionNode = z.object({
  ...nodeBase,
  type: z.literal('decision'),
  action: decisionAction,
  /** How long an approval waits for someone to decide. */
  timeoutSec: z.number().int().min(10).max(3600).default(300),
  /** Shown to the user when this decision blocks or holds the request. */
  reason: z.string().max(200).default(''),
})

export const policyNode = z.discriminatedUnion('type', [
  triggerNode,
  matchNode,
  checkNode,
  decisionNode,
])
export type PolicyNode = z.infer<typeof policyNode>
export type PolicyNodeType = PolicyNode['type']
export type MatchNode = z.infer<typeof matchNode>
export type CheckNode = z.infer<typeof checkNode>
export type DecisionNode = z.infer<typeof decisionNode>

export const policyEdge = z.object({
  id: z.string().min(1),
  source: z.string(),
  sourceHandle: z.string(),
  target: z.string(),
})
export type PolicyEdge = z.infer<typeof policyEdge>

export const policyGraph = z.object({
  nodes: z.array(policyNode).max(200),
  edges: z.array(policyEdge).max(400),
  /** What happens when a request reaches an output with nothing connected. */
  fallback: z.enum(['allow', 'block']).default('block'),
})
export type PolicyGraph = z.infer<typeof policyGraph>

/** The outputs a node exposes, in display order. */
export function nodeOutputs(node: PolicyNode): string[] {
  switch (node.type) {
    case 'trigger':
      return ['next']
    case 'match':
      return ['match', 'else']
    case 'decision':
      return []
    case 'check':
      switch (node.check.type) {
        case 'fingerprint':
          return ['pass', 'new', 'mismatch']
        case 'keywords':
          return ['pass', 'fail']
        case 'judge':
          return ['pass', 'fail', 'error']
        case 'redact':
          return ['pass']
      }
  }
}

export const outputLabels: Record<string, string> = {
  next: 'next',
  match: 'match',
  else: 'else',
  pass: 'pass',
  fail: 'fail',
  error: 'error',
  new: 'new device',
  mismatch: 'mismatch',
}

export type GraphIssue = { level: 'error' | 'warning'; nodeId?: string; message: string }

/** Structural problems. Errors prevent publishing; warnings are worth a look. */
export function validateGraph(graph: PolicyGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  if (byId.size !== graph.nodes.length)
    issues.push({ level: 'error', message: 'Duplicate node ids' })

  const triggers = graph.nodes.filter((n) => n.type === 'trigger')
  if (triggers.length !== 1) {
    issues.push({ level: 'error', message: 'The workflow needs exactly one start node' })
  }

  const out = new Map<string, string[]>()
  const used = new Set<string>()
  for (const e of graph.edges) {
    const source = byId.get(e.source)
    const target = byId.get(e.target)
    if (!source || !target) {
      issues.push({ level: 'error', message: `Edge ${e.id} points at a missing node` })
      continue
    }
    if (!nodeOutputs(source).includes(e.sourceHandle)) {
      issues.push({
        level: 'error',
        nodeId: source.id,
        message: `Unknown output "${e.sourceHandle}"`,
      })
    }
    if (target.type === 'trigger') {
      issues.push({
        level: 'error',
        nodeId: target.id,
        message: 'Nothing can lead into the start node',
      })
    }
    const key = `${e.source}:${e.sourceHandle}`
    if (used.has(key)) {
      issues.push({ level: 'error', nodeId: source.id, message: 'An output can only connect once' })
    }
    used.add(key)
    out.set(e.source, [...(out.get(e.source) ?? []), e.target])
  }

  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    const cyclic = (out.get(id) ?? []).some(visit)
    state.set(id, 'done')
    return cyclic
  }
  if (graph.nodes.some((n) => visit(n.id))) {
    issues.push({ level: 'error', message: 'The workflow contains a loop' })
  }

  const reachable = new Set<string>()
  const stack = triggers.map((t) => t.id)
  while (stack.length) {
    const id = stack.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    stack.push(...(out.get(id) ?? []))
  }

  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) {
      issues.push({ level: 'warning', nodeId: n.id, message: 'Not reachable from the start' })
    }
    if (n.type === 'match' && n.conditions.length === 0) {
      issues.push({ level: 'error', nodeId: n.id, message: 'Add at least one condition' })
    }
    if (n.type === 'match' && n.conditions.some((c) => c.values.length === 0)) {
      issues.push({ level: 'error', nodeId: n.id, message: 'A condition has no values' })
    }
    const open = nodeOutputs(n).filter((h) => !used.has(`${n.id}:${h}`))
    if (open.length && reachable.has(n.id)) {
      issues.push({
        level: 'warning',
        nodeId: n.id,
        message: `${open.map((h) => outputLabels[h] ?? h).join(', ')} → ${graph.fallback}`,
      })
    }
  }
  return issues
}

/**
 * Fingerprint the device, then keyword-scan everything. New devices wait for approval, copied
 * tokens and dangerous commands are blocked.
 */
export const defaultWorkflow: PolicyGraph = {
  fallback: 'block',
  nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 120 } },
    {
      id: 'fingerprint',
      type: 'check',
      position: { x: 240, y: 100 },
      enabled: true,
      check: { type: 'fingerprint' },
    },
    {
      id: 'keywords',
      type: 'check',
      position: { x: 520, y: 40 },
      enabled: true,
      check: {
        type: 'keywords',
        mode: 'substring',
        caseSensitive: false,
        patterns: ['rm -rf /', 'DROP DATABASE', 'curl * | sh', 'aws_secret_access_key'],
      },
    },
    {
      id: 'allow',
      type: 'decision',
      position: { x: 820, y: 0 },
      action: 'allow',
      timeoutSec: 300,
      reason: '',
    },
    {
      id: 'approve',
      type: 'decision',
      position: { x: 520, y: 220 },
      action: 'require_approval',
      timeoutSec: 300,
      reason: 'Request from a new device',
    },
    {
      id: 'block',
      type: 'decision',
      position: { x: 820, y: 160 },
      action: 'block',
      timeoutSec: 300,
      reason: '',
    },
  ],
  edges: [
    { id: 'e1', source: 'start', sourceHandle: 'next', target: 'fingerprint' },
    { id: 'e2', source: 'fingerprint', sourceHandle: 'pass', target: 'keywords' },
    { id: 'e3', source: 'fingerprint', sourceHandle: 'new', target: 'approve' },
    { id: 'e4', source: 'fingerprint', sourceHandle: 'mismatch', target: 'block' },
    { id: 'e5', source: 'keywords', sourceHandle: 'pass', target: 'allow' },
    { id: 'e6', source: 'keywords', sourceHandle: 'fail', target: 'block' },
  ],
}

export const checkLabels: Record<CheckType, string> = {
  fingerprint: 'Device fingerprint',
  keywords: 'Dangerous keywords',
  judge: 'Judge model',
  redact: 'Redact secrets and PII',
}

/** Labels for the `type` stored on each entry of an event's `checks`. */
export const stepLabels: Record<string, string> = {
  ...checkLabels,
  match: 'Route',
  decision: 'Decision',
}

export const rateLimitRule = z.object({
  id: z.string(),
  scope: z.enum(['mcp', 'tool', 'resource']),
  /** MCP server id, `<server>__<tool>` name, or resource id. `*` matches any target in scope. */
  target: z.string().min(1),
  limit: z.number().int().min(1),
  windowSec: z.number().int().min(1).max(86_400),
  per: z.enum(['user', 'org']).default('user'),
})
export type RateLimitRule = z.infer<typeof rateLimitRule>
