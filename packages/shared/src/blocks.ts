import type { ApprovalMethod } from './events.ts'
import type { CheckConfig, CheckType, Condition, PolicyNode, PolicyNodeType } from './workflow.ts'

/**
 * Every workflow node is an instance of a block. A block declares what it reads from the
 * request, the outputs a request can leave through, and which blocks commonly follow each
 * output. The editor renders, connects and suggests nodes from this alone; what a check does
 * at runtime lives in `engine.ts`.
 */

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral' | 'accent'

export type BlockId =
  | 'trigger'
  | 'route'
  | CheckType
  | 'allow'
  | 'block'
  | `approve_${ApprovalMethod}`

export type BlockGroup = 'Routing' | 'Content' | 'Tool' | 'Device' | 'Session' | 'Outcome'

/** Request data a block reads. The test panel only asks for what the graph's blocks use. */
export type BlockInput =
  | 'content'
  | 'tool'
  | 'arguments'
  | 'identity'
  | 'device'
  | 'key_storage'
  | 'presence'
  | 'posture'
  | 'os_posture'
  | 'network'
  | 'untrusted'
  | 'hook'
  | 'idle'
  | 'definition'

export const inputLabels: Record<BlockInput, string> = {
  content: 'Prompt, tool result or tool arguments',
  tool: 'Tool name, server and tier',
  arguments: 'Tool arguments',
  identity: 'User, groups and resources',
  device: 'Device fingerprint',
  key_storage: 'Where the device key is stored',
  presence: 'Touch ID proof, browser approval or confirmation',
  posture: 'EDR posture (CrowdStrike ZTA)',
  os_posture: 'Built-in OS protections',
  network: 'IP address and location',
  untrusted: 'Untrusted content read in the session',
  hook: "Claude Code's hook record of the call",
  idle: 'Keyboard and mouse idle time',
  definition: 'Pinned tool definition',
}

export type BlockOutput = {
  id: string
  label: string
  tone: Tone
  /** Blocks that commonly follow this output, best first. Any other block can still follow. */
  next: BlockId[]
}

type Option = { value: string; label: string }

/** A setting of a block, edited with a generic form. Keys address the check (or the node). */
export type BlockField = { key: string; label: string; hint?: string } & (
  | { kind: 'text' | 'longtext' | 'lines'; placeholder?: string }
  | { kind: 'number'; min: number; max: number; step?: number }
  | { kind: 'select' | 'multi'; options: Option[] }
  | { kind: 'switch' }
  | { kind: 'argument_rules' }
)

type Body<N> = N extends PolicyNode ? Omit<N, 'id' | 'position'> : never
/** A node without its id and position. */
export type NodeBody = Body<PolicyNode>

export type BlockSpec = {
  id: BlockId
  nodeType: PolicyNodeType
  group: BlockGroup
  label: string
  description: string
  inputs: BlockInput[]
  outputs: BlockOutput[]
  /** The output an inserted block continues the existing path through; null for outcomes. */
  through: string | null
  fields: BlockField[]
  create: () => NodeBody
  /** One line shown on the node. */
  summary: (node: PolicyNode) => string
}

const conditionLabels: Record<Condition['field'], string> = {
  kind: 'Kind',
  mcpServer: 'MCP server',
  tool: 'Tool',
  resource: 'Resource',
  group: 'Group',
  deviceStatus: 'Device',
  model: 'Model',
  tier: 'Tier',
  keyStorage: 'Key storage',
}

export function conditionText(c: Condition, names: Record<string, string> = {}): string {
  const values = c.values.map((v) => names[v] ?? v)
  return `${conditionLabels[c.field]}: ${values.join(', ') || '—'}`
}

export const approvalLabels: Record<ApprovalMethod, string> = {
  admin: 'Admin approval',
  confirm: 'Confirm in Claude Code',
  touchid: 'Touch ID',
  browser: 'Browser sign-in',
}

const piiOptions: Option[] = [
  { value: 'email', label: 'Email addresses' },
  { value: 'phone', label: 'Phone numbers' },
  { value: 'iban', label: 'IBANs' },
  { value: 'credit_card', label: 'Card numbers' },
  { value: 'ipv4', label: 'IP addresses' },
  { value: 'pesel', label: 'PESEL numbers' },
]

const osPostureOptions: Option[] = [
  { value: 'fv', label: 'FileVault (disk encryption)' },
  { value: 'sip', label: 'System Integrity Protection' },
  { value: 'gk', label: 'Gatekeeper' },
  { value: 'fw', label: 'Firewall' },
]

const pass = (label: string, next: BlockId[]): BlockOutput => ({
  id: 'pass',
  label,
  tone: 'ok',
  next,
})

type CheckOf<T extends CheckType> = Extract<CheckConfig, { type: T }>

function checkBlock<T extends CheckType>(
  type: T,
  spec: Pick<BlockSpec, 'group' | 'label' | 'description' | 'inputs' | 'outputs'> & {
    fields?: BlockField[]
    defaults: CheckOf<T>
    summary: (check: CheckOf<T>) => string
  },
): BlockSpec {
  return {
    id: type,
    nodeType: 'check',
    group: spec.group,
    label: spec.label,
    description: spec.description,
    inputs: spec.inputs,
    outputs: spec.outputs,
    through: 'pass',
    fields: spec.fields ?? [],
    create: () => ({ type: 'check', enabled: true, check: structuredClone(spec.defaults) }),
    summary: (node) =>
      node.type === 'check' && node.check.type === type
        ? spec.summary(node.check as CheckOf<T>)
        : '',
  }
}

const reasonField: BlockField = {
  kind: 'text',
  key: 'reason',
  label: 'Reason',
  hint: 'Shown to the user and in the approval queue.',
}

function approvalBlock(method: ApprovalMethod, description: string, wait: string): BlockSpec {
  return {
    id: `approve_${method}`,
    nodeType: 'decision',
    group: 'Outcome',
    label: approvalLabels[method],
    description,
    inputs: method === 'admin' ? [] : ['presence'],
    outputs: [],
    through: null,
    fields: [
      {
        kind: 'number',
        key: 'timeoutSec',
        label: 'Approval timeout (seconds)',
        hint: 'Declined when nobody decides in time.',
        min: 10,
        max: 3600,
      },
      reasonField,
    ],
    create: () => ({
      type: 'decision',
      action: 'require_approval',
      method,
      timeoutSec: method === 'admin' ? 300 : 120,
      reason: '',
    }),
    summary: (node) =>
      node.type === 'decision' ? node.reason || `${wait}, up to ${node.timeoutSec}s` : '',
  }
}

const specs: BlockSpec[] = [
  {
    id: 'trigger',
    nodeType: 'trigger',
    group: 'Routing',
    label: 'Request comes in',
    description:
      'Decides which requests start this workflow. Without conditions every prompt and tool call does. A request that starts no workflow is allowed.',
    inputs: [],
    outputs: [
      {
        id: 'next',
        label: 'Continue',
        tone: 'accent',
        next: ['fingerprint', 'posture', 'route', 'keywords'],
      },
    ],
    through: 'next',
    fields: [],
    create: () => ({ type: 'trigger', mode: 'all', conditions: [] }),
    summary: (node) =>
      node.type !== 'trigger' || node.conditions.length === 0
        ? 'Every prompt and tool call'
        : node.conditions.map((c) => conditionText(c)).join(node.mode === 'all' ? ' and ' : ' or '),
  },
  {
    id: 'route',
    nodeType: 'match',
    group: 'Routing',
    label: 'Route',
    description: 'Send requests down different paths by tool, tier, server, team, device or model.',
    inputs: ['tool', 'identity', 'device', 'key_storage'],
    outputs: [
      {
        id: 'match',
        label: 'Matches',
        tone: 'accent',
        next: ['keywords', 'arguments', 'untrusted_content', 'judge', 'approve_touchid'],
      },
      {
        id: 'else',
        label: 'Otherwise',
        tone: 'neutral',
        next: ['route', 'keywords', 'redact', 'allow'],
      },
    ],
    through: 'match',
    fields: [],
    create: () => ({ type: 'match', label: '', mode: 'all', conditions: [] }),
    summary: (node) =>
      node.type !== 'match' || node.conditions.length === 0
        ? 'No conditions'
        : node.conditions.map((c) => conditionText(c)).join(node.mode === 'all' ? ' and ' : ' or '),
  },
  checkBlock('fingerprint', {
    group: 'Device',
    label: 'Device fingerprint',
    description:
      'Compares the device presenting the token with the one it was issued to. Approving a request that came through New device also trusts that device.',
    inputs: ['device'],
    outputs: [
      pass('Passed', ['keywords', 'posture', 'judge', 'redact', 'route']),
      {
        id: 'new',
        label: 'New device',
        tone: 'warn',
        next: ['approve_admin', 'keywords', 'approve_browser', 'block'],
      },
      { id: 'mismatch', label: 'Device mismatch', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    defaults: { type: 'fingerprint' },
    summary: () => 'Known, new or copied device',
  }),
  checkBlock('posture', {
    group: 'Device',
    label: 'Device posture (EDR)',
    description:
      'Reads the CrowdStrike Zero Trust score for the device. A raised detection or a contained host leaves through Compromised; a stale, missing or unconfirmed score through Unknown.',
    inputs: ['posture'],
    outputs: [
      pass('Healthy', ['os_posture', 'network', 'keywords', 'route']),
      { id: 'low', label: 'Low score', tone: 'warn', next: ['route', 'block', 'approve_browser'] },
      { id: 'compromised', label: 'Compromised', tone: 'bad', next: ['block'] },
      {
        id: 'unknown',
        label: 'Unknown',
        tone: 'warn',
        next: ['approve_browser', 'route', 'block'],
      },
    ],
    fields: [
      {
        kind: 'number',
        key: 'minScore',
        label: 'Low below score',
        hint: '0 to 100. The lower of the device token and the Falcon cloud score is used.',
        min: 0,
        max: 100,
      },
    ],
    defaults: { type: 'posture', minScore: 50 },
    summary: (c) => `Score ≥ ${c.minScore}`,
  }),
  checkBlock('os_posture', {
    group: 'Device',
    label: 'OS protections',
    description:
      'Built-in checks the device reports about itself. A baseline for machines without an EDR; fails when a required protection is off.',
    inputs: ['os_posture'],
    outputs: [
      pass('Passed', ['network', 'keywords', 'route']),
      {
        id: 'fail',
        label: 'Protection off',
        tone: 'bad',
        next: ['block', 'route', 'approve_browser'],
      },
    ],
    fields: [{ kind: 'multi', key: 'require', label: 'Must be on', options: osPostureOptions }],
    defaults: { type: 'os_posture', require: ['fv', 'sip'] },
    summary: (c) => c.require.join(', ') || 'nothing required',
  }),
  checkBlock('network', {
    group: 'Device',
    label: 'Network and location',
    description:
      'Flags the first request from a network this device has not used before, and jumps in location faster than a plane.',
    inputs: ['network'],
    outputs: [
      pass('Known network', ['hook', 'idle', 'keywords', 'allow']),
      {
        id: 'new_network',
        label: 'New network',
        tone: 'warn',
        next: ['approve_browser', 'approve_touchid', 'approve_admin'],
      },
      {
        id: 'travel',
        label: 'Impossible travel',
        tone: 'bad',
        next: ['approve_browser', 'block', 'approve_admin'],
      },
    ],
    fields: [
      {
        kind: 'number',
        key: 'maxTravelKmh',
        label: 'Impossible above (km/h)',
        hint: 'Speed implied by the distance from the previous request.',
        min: 100,
        max: 5000,
        step: 50,
      },
    ],
    defaults: { type: 'network', maxTravelKmh: 900 },
    summary: (c) => `New network, or travel > ${c.maxTravelKmh} km/h`,
  }),
  checkBlock('keywords', {
    group: 'Content',
    label: 'Dangerous keywords',
    description:
      'Scans the prompt or tool arguments for patterns. Any match leaves through Failed.',
    inputs: ['content'],
    outputs: [
      pass('Passed', ['judge', 'redact', 'untrusted_content', 'allow']),
      { id: 'fail', label: 'Failed', tone: 'bad', next: ['block', 'approve_admin', 'judge'] },
    ],
    fields: [
      {
        kind: 'lines',
        key: 'patterns',
        label: 'Patterns',
        hint: 'One per line. In substring mode * is a wildcard; in regex mode each line is a regular expression.',
      },
      {
        kind: 'select',
        key: 'mode',
        label: 'Match mode',
        options: [
          { value: 'substring', label: 'Substring / wildcard' },
          { value: 'regex', label: 'Regular expression' },
        ],
      },
      { kind: 'switch', key: 'caseSensitive', label: 'Case sensitive' },
    ],
    defaults: { type: 'keywords', patterns: [], mode: 'substring', caseSensitive: false },
    summary: (c) => `${c.patterns.length} patterns`,
  }),
  checkBlock('judge', {
    group: 'Content',
    label: 'Judge model',
    description:
      'Sends the input to a model on OpenRouter, or to any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM), and asks for a risk score between 0 and 1. Leaves through Error when the judge is down or times out.',
    inputs: ['content', 'tool'],
    outputs: [
      pass('Passed', ['redact', 'allow', 'untrusted_content']),
      {
        id: 'fail',
        label: 'Failed',
        tone: 'bad',
        next: ['block', 'approve_admin', 'approve_touchid'],
      },
      { id: 'error', label: 'Error', tone: 'warn', next: ['approve_admin', 'block', 'keywords'] },
    ],
    fields: [
      {
        kind: 'text',
        key: 'endpoint',
        label: 'Endpoint',
        hint: "Chat completions URL. OpenRouter uses the gateway's key; other hosts use JUDGE_API_KEY.",
      },
      { kind: 'text', key: 'model', label: 'Model' },
      { kind: 'number', key: 'threshold', label: 'Fail at risk ≥', min: 0, max: 1, step: 0.05 },
      { kind: 'number', key: 'timeoutMs', label: 'Timeout (ms)', min: 100, max: 30_000 },
      {
        kind: 'longtext',
        key: 'instructions',
        label: 'Extra instructions',
        hint: "Company-specific rules appended to the judge's system prompt.",
      },
    ],
    defaults: {
      type: 'judge',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'anthropic/claude-haiku-4.5',
      threshold: 0.7,
      timeoutMs: 8000,
      instructions: '',
    },
    summary: (c) => `${c.model} · risk ≥ ${c.threshold}`,
  }),
  checkBlock('redact', {
    group: 'Content',
    label: 'Redact secrets and PII',
    description:
      'Replaces secrets and personal data with stable placeholders like [REDACTED_EMAIL_1] before they reach the model, and in MCP tool results. When the agent passes a placeholder back into a tool call, the gateway swaps the real value in. Never blocks.',
    inputs: ['content'],
    outputs: [pass('Continue', ['allow', 'judge', 'keywords'])],
    fields: [
      {
        kind: 'switch',
        key: 'secrets',
        label: 'Secrets (API keys, tokens, private keys, passwords)',
      },
      { kind: 'multi', key: 'pii', label: 'Personal data', options: piiOptions },
    ],
    defaults: { type: 'redact', secrets: true, pii: ['email', 'phone', 'iban', 'credit_card'] },
    summary: (c) =>
      [c.secrets ? 'secrets' : null, ...c.pii].filter(Boolean).join(', ') || 'nothing selected',
  }),
  checkBlock('arguments', {
    group: 'Tool',
    label: 'Argument rules',
    description:
      'Refuses a tool call when an argument does not match its allowed pattern, for example email_send may only send to @company.com.',
    inputs: ['tool', 'arguments'],
    outputs: [
      pass('Passed', ['untrusted_content', 'approve_confirm', 'allow']),
      { id: 'fail', label: 'Rule violated', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    fields: [
      {
        kind: 'argument_rules',
        key: 'rules',
        label: 'Rules',
        hint: 'Every value of the argument has to match the regular expression. Tool is a glob with *.',
      },
    ],
    defaults: { type: 'arguments', rules: [] },
    summary: (c) => `${c.rules.length} ${c.rules.length === 1 ? 'rule' : 'rules'}`,
  }),
  checkBlock('tool_pinning', {
    group: 'Tool',
    label: 'Tool definition pin',
    description:
      'Compares the tool with the definition an admin pinned. A changed name, description or schema is how tool poisoning and rug pulls arrive.',
    inputs: ['definition'],
    outputs: [
      pass('Unchanged', ['arguments', 'untrusted_content', 'allow']),
      { id: 'changed', label: 'Definition changed', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    defaults: { type: 'tool_pinning' },
    summary: () => 'Same definition as pinned',
  }),
  checkBlock('untrusted_content', {
    group: 'Session',
    label: 'Untrusted content guard',
    description:
      'Prompt-injection guard. After the session reads untrusted content (a web page, an inbox, a ticket), requests leave through Recently read for the length of the window.',
    inputs: ['untrusted'],
    outputs: [
      pass('Clean session', ['allow', 'redact', 'approve_confirm']),
      {
        id: 'tainted',
        label: 'Recently read',
        tone: 'warn',
        next: ['approve_browser', 'approve_touchid', 'judge', 'block'],
      },
    ],
    fields: [
      { kind: 'number', key: 'windowMinutes', label: 'Window (minutes)', min: 1, max: 1440 },
    ],
    defaults: { type: 'untrusted_content', windowMinutes: 10 },
    summary: (c) => `Read in the last ${c.windowMinutes} min`,
  }),
  checkBlock('hook', {
    group: 'Session',
    label: 'Started by Claude Code',
    description:
      "Checks that Claude Code's own hook recorded this exact tool call. A call without a record came from something else holding the session.",
    inputs: ['hook'],
    outputs: [
      pass('Hook record found', ['idle', 'untrusted_content', 'allow']),
      {
        id: 'fail',
        label: 'No hook record',
        tone: 'warn',
        next: ['approve_touchid', 'approve_browser', 'block'],
      },
    ],
    defaults: { type: 'hook' },
    summary: () => 'Tool call matches a hook record',
  }),
  checkBlock('idle', {
    group: 'Session',
    label: 'User at the keyboard',
    description:
      'Uses keyboard and mouse idle time on the device. An agent acting while nobody is there is worth a second look.',
    inputs: ['idle'],
    outputs: [
      pass('User active', ['untrusted_content', 'allow', 'redact']),
      {
        id: 'idle',
        label: 'User away',
        tone: 'warn',
        next: ['approve_touchid', 'approve_browser', 'block'],
      },
    ],
    fields: [
      { kind: 'number', key: 'maxMinutes', label: 'Away after (minutes)', min: 1, max: 1440 },
    ],
    defaults: { type: 'idle', maxMinutes: 30 },
    summary: (c) => `Idle under ${c.maxMinutes} min`,
  }),
  {
    id: 'allow',
    nodeType: 'decision',
    group: 'Outcome',
    label: 'Allow',
    description: 'Forward the request.',
    inputs: [],
    outputs: [],
    through: null,
    fields: [],
    create: () => ({
      type: 'decision',
      action: 'allow',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    }),
    summary: () => 'Forward the request',
  },
  approvalBlock(
    'admin',
    'Hold the request until an administrator approves it in the dashboard.',
    'Wait for an admin',
  ),
  approvalBlock(
    'confirm',
    'Ask the person in Claude Code to confirm. The lightest level: the device reports the answer, the gateway cannot verify it.',
    'Ask in Claude Code',
  ),
  approvalBlock(
    'touchid',
    'Require a Touch ID proof from the device for this exact request. Devices without Touch ID are sent to the browser instead.',
    'Wait for Touch ID',
  ),
  approvalBlock(
    'browser',
    "Require the device's owner to sign in again in the browser and approve this exact action.",
    'Wait for a fresh sign-in',
  ),
  {
    id: 'block',
    nodeType: 'decision',
    group: 'Outcome',
    label: 'Block',
    description: 'Deny the request.',
    inputs: [],
    outputs: [],
    through: null,
    fields: [reasonField],
    create: () => ({
      type: 'decision',
      action: 'block',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    }),
    summary: (node) => (node.type === 'decision' && node.reason) || 'Deny the request',
  },
]

export const blocks = Object.fromEntries(specs.map((b) => [b.id, b])) as Record<BlockId, BlockSpec>

/** Everything that can be added to a workflow, in display order. */
export const palette: BlockSpec[] = specs.filter((b) => b.id !== 'trigger')

export function blockId(node: PolicyNode): BlockId {
  switch (node.type) {
    case 'trigger':
      return 'trigger'
    case 'match':
      return 'route'
    case 'check':
      return node.check.type
    case 'decision':
      return node.action === 'require_approval' ? `approve_${node.method}` : node.action
  }
}

export function blockOf(node: PolicyNode): BlockSpec {
  return blocks[blockId(node)]
}

export function blockOutput(node: PolicyNode, output: string): BlockOutput | undefined {
  return blockOf(node).outputs.find((o) => o.id === output)
}

/** Labels for the `type` stored on each entry of an event's `checks`. */
export const stepLabels: Record<string, string> = {
  ...Object.fromEntries(specs.filter((b) => b.nodeType === 'check').map((b) => [b.id, b.label])),
  match: 'Route',
  decision: 'Decision',
}
