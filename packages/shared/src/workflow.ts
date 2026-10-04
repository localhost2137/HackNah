import { z } from 'zod'
import { blockOf } from './blocks.ts'
import { approvalMethod, eventKind } from './events.ts'
import { signatureCategory, signatureSeverity } from './signatures.ts'

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

/** Known attack signatures: the built-in baseline plus whatever the external feed delivers. */
export const signaturesCheck = z.object({
  type: z.literal('signatures'),
  /** Strictness: signatures below this severity are ignored. */
  minSeverity: signatureSeverity.default('medium'),
  /** Empty means every category. */
  categories: z.array(signatureCategory).default([]),
})

/** Models trained on labelled datasets: flags requests that look like those attacks. */
export const learnedCheck = z.object({
  type: z.literal('learned'),
  /** Score in [0, 1] at or above which the check fails. */
  threshold: z.number().min(0.05).max(0.99).default(0.5),
  /** Slugs of the datasets the block's model is trained on, picked in the editor. */
  datasets: z.array(z.string()).default([]),
  /** The trained model for that selection. Empty until it is trained: the check is skipped. */
  models: z.array(z.string()).default([]),
})

export const argumentRule = z.object({
  /** Glob on the tool name; MCP tools match with or without the server prefix. */
  tool: z.string().min(1).default('*'),
  argument: z.string().min(1),
  /** Regular expression every value of that argument has to match. */
  pattern: z.string().min(1),
  /** Shown when the argument is refused. */
  message: z.string().max(200).default(''),
})
export type ArgumentRule = z.infer<typeof argumentRule>

export const argumentsCheck = z.object({
  type: z.literal('arguments'),
  rules: z.array(argumentRule).max(50).default([]),
})

/** Prompt-injection guard: has the session read untrusted content recently? */
export const untrustedContentCheck = z.object({
  type: z.literal('untrusted_content'),
  windowMinutes: z.number().int().min(1).max(1440).default(10),
})

export const toolPinningCheck = z.object({ type: z.literal('tool_pinning') })

export const postureCheck = z.object({
  type: z.literal('posture'),
  /** EDR score (0 to 100) below which the request leaves through `low`. */
  minScore: z.number().int().min(0).max(100).default(50),
})

/** FileVault, System Integrity Protection, Gatekeeper, firewall. */
export const osPostureKey = z.enum(['fv', 'sip', 'gk', 'fw'])
export type OsPostureKey = z.infer<typeof osPostureKey>

export const osPostureCheck = z.object({
  type: z.literal('os_posture'),
  require: z.array(osPostureKey).default(['fv', 'sip']),
})

export const networkCheck = z.object({
  type: z.literal('network'),
  maxTravelKmh: z.number().int().min(100).max(5000).default(900),
})

export const hookCheck = z.object({ type: z.literal('hook') })

/** Reads a rule from the Limits page whose action is "let the workflow decide". */
export const limitCheck = z.object({
  type: z.literal('limit'),
  limitId: z.string().default(''),
})

export const idleCheck = z.object({
  type: z.literal('idle'),
  maxMinutes: z.number().int().min(1).max(1440).default(30),
})

export const checkConfig = z.discriminatedUnion('type', [
  fingerprintCheck,
  keywordsCheck,
  judgeCheck,
  redactCheck,
  signaturesCheck,
  learnedCheck,
  argumentsCheck,
  untrustedContentCheck,
  toolPinningCheck,
  postureCheck,
  osPostureCheck,
  networkCheck,
  hookCheck,
  idleCheck,
  limitCheck,
])
export type CheckConfig = z.infer<typeof checkConfig>
export type CheckType = CheckConfig['type']
export type JudgeCheck = z.infer<typeof judgeCheck>

export const toolTier = z.enum(['read', 'write', 'destructive'])
export type ToolTier = z.infer<typeof toolTier>

export const keyStorage = z.enum(['secure_enclave', 'software', 'tpm'])
export type KeyStorage = z.infer<typeof keyStorage>

const patterns = z.array(z.string().min(1))

export const condition = z.discriminatedUnion('field', [
  /** The stage: model input, tool call, tool result, model output or agent message. */
  z.object({ field: z.literal('kind'), values: z.array(eventKind) }),
  /** Whether a tool comes from a connected MCP server or is built into the agent. */
  z.object({ field: z.literal('source'), values: z.array(z.enum(['mcp', 'builtin'])) }),
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
  z.object({ field: z.literal('tier'), values: z.array(toolTier) }),
  /** Where the device keeps its signing key. */
  z.object({ field: z.literal('keyStorage'), values: z.array(keyStorage) }),
])
export type Condition = z.infer<typeof condition>
export type ConditionField = Condition['field']

/** `skip` ends a workflow without a decision, as if it had not started. */
export const decisionAction = z.enum(['allow', 'block', 'require_approval', 'skip'])
export type DecisionAction = z.infer<typeof decisionAction>

const position = z.object({ x: z.number(), y: z.number() })
const nodeBase = { id: z.string().min(1).max(64), position }

export const triggerNode = z.object({
  ...nodeBase,
  type: z.literal('trigger'),
  /** The stages this workflow runs on. Empty means every stage. */
  stages: z.array(eventKind).default([]),
})
export type TriggerNode = z.infer<typeof triggerNode>

/** One question about the request, answered Yes or No. Chained, they make AND and OR. */
export const conditionNode = z.object({
  ...nodeBase,
  type: z.literal('condition'),
  condition,
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
  /** Who approves when the action is `require_approval`. */
  method: approvalMethod.default('admin'),
  /** How long an approval waits for someone to decide. */
  timeoutSec: z.number().int().min(10).max(3600).default(300),
  /** Shown to the user when this decision blocks or holds the request. */
  reason: z.string().max(200).default(''),
})

export const policyNode = z.discriminatedUnion('type', [
  triggerNode,
  conditionNode,
  checkNode,
  decisionNode,
])
export type PolicyNode = z.infer<typeof policyNode>
export type PolicyNodeType = PolicyNode['type']
export type ConditionNode = z.infer<typeof conditionNode>
export type CheckNode = z.infer<typeof checkNode>
export type DecisionNode = z.infer<typeof decisionNode>

export const policyEdge = z.object({
  id: z.string().min(1),
  source: z.string(),
  sourceHandle: z.string(),
  target: z.string(),
})
export type PolicyEdge = z.infer<typeof policyEdge>

export const policyGraph = z.preprocess(
  upgradeGraph,
  z.object({
    nodes: z.array(policyNode).max(200),
    // Checks no longer have an Error output; a failing check follows the fallback.
    edges: z
      .array(policyEdge)
      .max(400)
      .transform((edges) => edges.filter((e) => e.sourceHandle !== 'error')),
    /** What happens when a request reaches an output with nothing connected, or a check errors. */
    fallback: z.enum(['allow', 'block']).default('block'),
  }),
)
export type PolicyGraph = z.infer<typeof policyGraph>

type RawNode = {
  id: string
  type: string
  position?: { x: number; y: number }
  [k: string]: unknown
}
type RawCondition = { field: string; values?: unknown[] }
type RawEdge = { id: string; source: string; sourceHandle: string; target: string }

/**
 * Graphs saved before condition blocks existed had conditions on the start node and multi-condition
 * Route nodes. Both become chains of condition blocks: AND links Yes to the next condition, OR
 * links No. A start condition that does not hold now ends in Skip, which, as before, means the
 * workflow does not apply.
 */
export function upgradeGraph(raw: unknown): unknown {
  const g = raw as { nodes?: RawNode[]; edges?: RawEdge[] } | null
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return raw
  const legacy = g.nodes.some(
    (n) => n?.type === 'match' || (n?.type === 'trigger' && Array.isArray(n.conditions)),
  )
  if (!legacy) return raw

  const ids = new Set(g.nodes.map((n) => n.id))
  const fresh = (base: string) => {
    let i = 2
    while (ids.has(`${base}-${i}`)) i++
    ids.add(`${base}-${i}`)
    return `${base}-${i}`
  }
  const nodes: RawNode[] = []
  let edges = [...g.edges]
  const target = (id: string, handle: string) =>
    edges.find((e) => e.source === id && e.sourceHandle === handle)?.target
  let skipId: string | null = null
  const skip = (at: { x: number; y: number }) => {
    if (!skipId) {
      skipId = fresh('skip')
      nodes.push({
        id: skipId,
        type: 'decision',
        position: { x: at.x + 340, y: at.y + 240 },
        action: 'skip',
        method: 'admin',
        timeoutSec: 300,
        reason: '',
      })
    }
    return skipId
  }
  const link = (source: string, sourceHandle: string, to: string | undefined) => {
    if (to) edges.push({ id: `${source}-${sourceHandle}`, source, sourceHandle, target: to })
  }
  /** Condition blocks for `conditions`, the first one taking `firstId`. */
  const chain = (
    firstId: string,
    conditions: RawCondition[],
    mode: unknown,
    at: { x: number; y: number },
    yes: string | undefined,
    no: string | undefined,
  ) => {
    const list = conditions.length ? conditions : [{ field: 'tool', values: [] }]
    const chainIds = list.map((_, i) => (i === 0 ? firstId : fresh(firstId)))
    list.forEach((c, i) => {
      const id = chainIds[i]!
      const next = chainIds[i + 1]
      nodes.push({
        id,
        type: 'condition',
        position: { x: at.x + i * 300, y: at.y },
        condition: { field: c.field, values: c.values ?? [] },
      })
      if (mode === 'any') {
        link(id, 'yes', yes)
        link(id, 'no', next ?? no)
      } else {
        link(id, 'yes', next ?? yes)
        link(id, 'no', no)
      }
    })
  }

  for (const n of g.nodes) {
    const at = n.position ?? { x: 0, y: 0 }
    if (n.type === 'trigger' && Array.isArray(n.conditions)) {
      const conditions = (n.conditions as RawCondition[]).filter((c) => c?.field)
      const stageConds = conditions.filter((c) => c.field === 'kind')
      const others = conditions.filter((c) => c.field !== 'kind')
      const next = target(n.id, 'next')
      let stages: unknown[] = []
      let rest = others
      if (n.mode === 'any' && others.length) rest = conditions
      else if (n.mode === 'any') stages = [...new Set(stageConds.flatMap((c) => c.values ?? []))]
      else if (stageConds.length)
        stages = stageConds
          .map((c) => c.values ?? [])
          .reduce((a, b) => a.filter((v) => b.includes(v)))
      const { conditions: _c, mode: _m, ...base } = n
      nodes.push({ ...base, stages })
      if (rest.length) {
        edges = edges.filter((e) => !(e.source === n.id && e.sourceHandle === 'next'))
        const first = fresh('if')
        link(n.id, 'next', first)
        chain(first, rest, n.mode, { x: at.x + 300, y: at.y }, next, skip(at))
      }
    } else if (n.type === 'match') {
      const yes = target(n.id, 'match')
      const no = target(n.id, 'else')
      edges = edges.filter((e) => e.source !== n.id)
      chain(n.id, (n.conditions as RawCondition[]) ?? [], n.mode, at, yes, no)
    } else {
      nodes.push(n)
    }
  }
  return { ...g, nodes, edges }
}

/** The ids of the outputs a node exposes, in display order. */
export function nodeOutputs(node: PolicyNode): string[] {
  return blockOf(node).outputs.map((o) => o.id)
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
    issues.push({ level: 'error', message: 'The guardrail needs exactly one start node' })
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
    issues.push({ level: 'error', message: 'The guardrail contains a loop' })
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
    if (n.type === 'condition' && n.condition.values.length === 0) {
      issues.push({ level: 'error', nodeId: n.id, message: 'Pick at least one value' })
    }
    if (n.type === 'check' && n.check.type === 'learned' && n.check.models.length === 0) {
      issues.push({
        level: 'warning',
        nodeId: n.id,
        message: 'No trained model: pick datasets and train, or this step always passes',
      })
    }
    if (n.type === 'check' && n.check.type === 'arguments' && n.check.rules.length === 0) {
      issues.push({ level: 'warning', nodeId: n.id, message: 'No argument rules: always passes' })
    }
    const open = blockOf(n).outputs.filter((o) => !used.has(`${n.id}:${o.id}`))
    if (open.length && reachable.has(n.id)) {
      issues.push({
        level: 'warning',
        nodeId: n.id,
        message: `${open.map((o) => o.label).join(', ')} → ${graph.fallback}`,
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
    { id: 'start', type: 'trigger', position: { x: 0, y: 100 }, stages: [] },
    {
      id: 'fingerprint',
      type: 'check',
      position: { x: 320, y: 100 },
      enabled: true,
      check: { type: 'fingerprint' },
    },
    {
      id: 'keywords',
      type: 'check',
      position: { x: 660, y: 0 },
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
      position: { x: 1000, y: 0 },
      action: 'allow',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    },
    {
      id: 'approve',
      type: 'decision',
      position: { x: 660, y: 340 },
      action: 'require_approval',
      method: 'admin',
      timeoutSec: 300,
      reason: 'Request from a new device',
    },
    {
      id: 'block',
      type: 'decision',
      position: { x: 1000, y: 220 },
      action: 'block',
      method: 'admin',
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

/** What a newly created workflow starts from: tool calls go straight to allow. */
export const starterWorkflow: PolicyGraph = {
  fallback: 'block',
  nodes: [
    {
      id: 'start',
      type: 'trigger',
      position: { x: 0, y: 100 },
      stages: ['tool_call'],
    },
    {
      id: 'allow',
      type: 'decision',
      position: { x: 340, y: 100 },
      action: 'allow',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    },
  ],
  edges: [{ id: 'e1', source: 'start', sourceHandle: 'next', target: 'allow' }],
}
