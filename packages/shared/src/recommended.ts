import type { ApprovalMethod, EventKind } from './events.ts'
import type { CheckConfig, Condition, PolicyGraph, PolicyNode } from './guardrail.ts'
import { signatureCategory } from './signatures.ts'

/** A trained model and the datasets it was trained on, as a Trained model block stores them. */
export type LearnedRef = { id: string; datasets: string[] }

export type RecommendedGuardrail = {
  id: string
  name: string
  description: string
  graph: PolicyGraph
}

/** Lays a graph out on a grid and names edges after their output. */
function builder(stages: EventKind[]) {
  const at = (col: number, row: number) => ({ x: col * 340, y: row * 200 })
  const nodes: PolicyNode[] = [{ id: 'start', type: 'trigger', position: at(0, 0), stages }]
  const edges: PolicyGraph['edges'] = []
  return {
    check(id: string, col: number, row: number, check: CheckConfig) {
      nodes.push({ id, type: 'check', position: at(col, row), enabled: true, check })
    },
    when(id: string, col: number, row: number, condition: Condition) {
      nodes.push({ id, type: 'condition', position: at(col, row), condition })
    },
    end(
      id: string,
      col: number,
      row: number,
      action: 'allow' | 'block' | 'require_approval',
      reason = '',
      method: ApprovalMethod = 'admin',
    ) {
      nodes.push({
        id,
        type: 'decision',
        position: at(col, row),
        action,
        method,
        timeoutSec: method === 'admin' ? 300 : 120,
        reason,
      })
    },
    link(source: string, sourceHandle: string, target: string) {
      edges.push({ id: `${source}-${sourceHandle}`, source, sourceHandle, target })
    },
    graph: (): PolicyGraph => ({ fallback: 'block', nodes, edges }),
  }
}

// Every category ticked, so the editor shows what the block looks for.
const ALL_ATTACKS = [...signatureCategory.options]

const PII = ['email', 'phone', 'iban', 'credit_card', 'pesel'] as const

const learned = (model: LearnedRef | null, threshold: number): CheckConfig => ({
  type: 'learned',
  threshold,
  datasets: model?.datasets ?? [],
  models: model ? [model.id] : [],
})

/** Who is asking: the device, its health and where it connects from. */
function deviceTrust(): PolicyGraph {
  const g = builder(['model_request', 'tool_call', 'agent_message'])
  g.check('device', 1, 0, { type: 'fingerprint' })
  g.check('edr', 2, 0, { type: 'posture', minScore: 60 })
  g.check('network', 3, 0, { type: 'network', maxTravelKmh: 900 })
  g.check('os', 4, 0, { type: 'os_posture', require: ['fv', 'sip'] })
  g.when('risky_tool', 5, 1, { field: 'tier', values: ['write', 'destructive'] })
  g.end('allow', 6, 0, 'allow')
  g.end('copied_token', 2, 2, 'block', 'This token belongs to another device')
  g.end('new_device', 2, 1, 'require_approval', 'Request from a new device')
  g.end('compromised', 3, 2, 'block', 'The device is reported as compromised')
  g.end('weak_device', 3, 1, 'require_approval', 'Device health score is low')
  g.end(
    'travel',
    4,
    2,
    'require_approval',
    'Sign in again: the location changed too fast',
    'browser',
  )
  g.end('unprotected', 6, 2, 'block', 'Tools that change data need disk encryption and SIP on')
  g.link('start', 'next', 'device')
  g.link('device', 'pass', 'edr')
  g.link('device', 'new', 'new_device')
  g.link('device', 'mismatch', 'copied_token')
  g.link('edr', 'pass', 'network')
  // A device without an EDR agent is not held back; the other device checks still run.
  g.link('edr', 'unknown', 'network')
  g.link('edr', 'low', 'weak_device')
  g.link('edr', 'compromised', 'compromised')
  g.link('network', 'pass', 'os')
  g.link('network', 'new_network', 'os')
  g.link('network', 'travel', 'travel')
  g.link('os', 'pass', 'allow')
  g.link('os', 'fail', 'risky_tool')
  g.link('risky_tool', 'yes', 'unprotected')
  g.link('risky_tool', 'no', 'allow')
  return g.graph()
}

/** What the user and the context send to the model. */
function modelInput(prompts: LearnedRef | null): PolicyGraph {
  const g = builder(['model_request'])
  g.check('known', 1, 0, { type: 'signatures', minSeverity: 'medium', categories: ALL_ATTACKS })
  g.check('injection', 2, 0, learned(prompts, 0.8))
  g.check('redact', 3, 0, { type: 'redact', secrets: true, pii: [...PII] })
  g.end('allow', 4, 0, 'allow')
  g.end('attack', 2, 1, 'block', 'Matches a known attack')
  g.end('looks_like_attack', 3, 1, 'block', 'Looks like a prompt injection or jailbreak')
  g.link('start', 'next', 'known')
  g.link('known', 'pass', 'injection')
  g.link('known', 'fail', 'attack')
  g.link('injection', 'pass', 'redact')
  g.link('injection', 'fail', 'looks_like_attack')
  g.link('redact', 'pass', 'allow')
  return g.graph()
}

/** What the agent is about to do. */
function toolCalls(): PolicyGraph {
  const g = builder(['tool_call'])
  g.check('hook', 1, 0, { type: 'hook' })
  g.when('rogue_writes', 1, 1, { field: 'tier', values: ['write', 'destructive'] })
  g.check('pin', 2, 0, { type: 'tool_pinning' })
  g.check('known', 3, 0, { type: 'signatures', minSeverity: 'low', categories: ALL_ATTACKS })
  g.check('keywords', 4, 0, {
    type: 'keywords',
    mode: 'substring',
    caseSensitive: false,
    patterns: [
      'DROP DATABASE',
      'DROP TABLE',
      'TRUNCATE TABLE',
      'aws_secret_access_key',
      'mkfs.',
      'dd if=* of=/dev/',
      'git push --force',
      'chmod -R 777',
    ],
  })
  g.check('arguments', 5, 0, {
    type: 'arguments',
    rules: ['to', 'cc', 'bcc'].map((argument) => ({
      tool: '*email*',
      argument,
      pattern: '@company\\.com$',
      message: `Email may only go to @company.com addresses (${argument})`,
    })),
  })
  g.check('untrusted', 6, 0, { type: 'untrusted_content', windowMinutes: 10 })
  g.when('tainted_writes', 6, 1, { field: 'tier', values: ['write', 'destructive'] })
  g.when('destructive', 7, 0, { field: 'tier', values: ['destructive'] })
  g.check('present', 7, 1, { type: 'idle', maxMinutes: 30 })
  g.end('allow', 8, 0, 'allow')
  g.end('rogue', 2, 2, 'block', 'Tool call was not started by Claude Code')
  g.end('poisoned', 3, 1, 'require_approval', 'The tool changed since it was approved')
  g.end('attack', 4, 1, 'block', 'Matches a known attack')
  g.end('dangerous', 5, 1, 'block', 'Dangerous command')
  g.end('bad_argument', 6, 2, 'block')
  g.end(
    'confirm',
    7,
    2,
    'require_approval',
    'Untrusted content was read just before this change',
    'confirm',
  )
  g.end('away', 8, 2, 'block', 'Destructive tool while the user is away')
  g.end('touch', 8, 1, 'require_approval', 'Destructive tool', 'touchid')
  g.link('start', 'next', 'hook')
  g.link('hook', 'pass', 'pin')
  g.link('hook', 'fail', 'rogue_writes')
  g.link('rogue_writes', 'yes', 'rogue')
  g.link('rogue_writes', 'no', 'pin')
  g.link('pin', 'pass', 'known')
  g.link('pin', 'changed', 'poisoned')
  g.link('known', 'pass', 'keywords')
  g.link('known', 'fail', 'attack')
  g.link('keywords', 'pass', 'arguments')
  g.link('keywords', 'fail', 'dangerous')
  g.link('arguments', 'pass', 'untrusted')
  g.link('arguments', 'fail', 'bad_argument')
  g.link('untrusted', 'pass', 'destructive')
  g.link('untrusted', 'tainted', 'tainted_writes')
  g.link('tainted_writes', 'yes', 'confirm')
  g.link('tainted_writes', 'no', 'destructive')
  g.link('destructive', 'no', 'allow')
  g.link('destructive', 'yes', 'present')
  g.link('present', 'pass', 'touch')
  g.link('present', 'idle', 'away')
  return g.graph()
}

/** What tools hand back: the way indirect prompt injection gets in. */
function toolResults(indirect: LearnedRef | null): PolicyGraph {
  const g = builder(['tool_result'])
  g.check('known', 1, 0, { type: 'signatures', minSeverity: 'medium', categories: ALL_ATTACKS })
  g.check('injection', 2, 0, learned(indirect, 0.8))
  g.check('redact', 3, 0, { type: 'redact', secrets: true, pii: [...PII] })
  g.end('allow', 4, 0, 'allow')
  g.end('attack', 2, 1, 'block', 'Tool result matches a known attack')
  g.end('injected', 3, 1, 'block', 'Tool result looks like it carries instructions')
  g.link('start', 'next', 'known')
  g.link('known', 'pass', 'injection')
  g.link('known', 'fail', 'attack')
  g.link('injection', 'pass', 'redact')
  g.link('injection', 'fail', 'injected')
  g.link('redact', 'pass', 'allow')
  return g.graph()
}

/** What the model answers. Streamed output cannot wait for an approval, so it only blocks. */
function modelOutput(): PolicyGraph {
  const g = builder(['model_output'])
  g.check('known', 1, 0, { type: 'signatures', minSeverity: 'medium', categories: ALL_ATTACKS })
  g.check('redact', 2, 0, { type: 'redact', secrets: true, pii: [] })
  g.end('allow', 3, 0, 'allow')
  g.end('attack', 2, 1, 'block', 'Model output matches a known attack')
  g.link('start', 'next', 'known')
  g.link('known', 'pass', 'redact')
  g.link('known', 'fail', 'attack')
  g.link('redact', 'pass', 'allow')
  return g.graph()
}

/** What one agent sends to another. */
function agentMessages(prompts: LearnedRef | null, indirect: LearnedRef | null): PolicyGraph {
  const g = builder(['agent_message'])
  g.check('known', 1, 0, { type: 'signatures', minSeverity: 'low', categories: ALL_ATTACKS })
  g.check('injection', 2, 0, learned(prompts, 0.8))
  g.check('instructions', 3, 0, learned(indirect, 0.8))
  g.check('redact', 4, 0, { type: 'redact', secrets: true, pii: [...PII] })
  g.end('allow', 5, 0, 'allow')
  g.end('attack', 2, 1, 'block', 'Agent message matches a known attack')
  g.end('injected', 4, 1, 'block', 'Agent message looks like a prompt injection')
  g.link('start', 'next', 'known')
  g.link('known', 'pass', 'injection')
  g.link('known', 'fail', 'attack')
  g.link('injection', 'pass', 'instructions')
  g.link('injection', 'fail', 'injected')
  g.link('instructions', 'pass', 'redact')
  g.link('instructions', 'fail', 'injected')
  g.link('redact', 'pass', 'allow')
  return g.graph()
}

/**
 * A starting set of guardrails, one per place a request can go wrong. Every block in them is
 * deterministic and runs in the gateway without a network call. The Trained model blocks need the
 * two starter models; without them those blocks are skipped.
 */
export function recommendedGuardrails(models: {
  prompts: LearnedRef | null
  indirect: LearnedRef | null
}): RecommendedGuardrail[] {
  return [
    {
      id: 'wf_device_trust',
      name: 'Device trust',
      description: 'Copied tokens, new or unhealthy devices and impossible travel.',
      graph: deviceTrust(),
    },
    {
      id: 'wf_model_input',
      name: 'Prompt screening',
      description: 'Known attacks, prompt injections and jailbreaks in what goes to the model.',
      graph: modelInput(models.prompts),
    },
    {
      id: 'wf_tool_calls',
      name: 'Tool call safety',
      description:
        'Known attacks, dangerous commands, changed tools and confirmation for risky tools.',
      graph: toolCalls(),
    },
    {
      id: 'wf_tool_results',
      name: 'Tool result screening',
      description: 'Instructions hidden in what tools return, and secrets in it.',
      graph: toolResults(models.indirect),
    },
    {
      id: 'wf_model_output',
      name: 'Model output',
      description: 'Known attacks and secrets in what the model answers.',
      graph: modelOutput(),
    },
    {
      id: 'wf_agent_messages',
      name: 'Agent messages',
      description: 'Attacks one agent passes on to another.',
      graph: agentMessages(models.prompts, models.indirect),
    },
  ]
}
