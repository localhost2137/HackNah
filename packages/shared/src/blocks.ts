import { type ApprovalMethod, type EventKind, eventKind, kindLabels } from './events.ts'
import type {
  CheckConfig,
  CheckType,
  Condition,
  ConditionField,
  PolicyNode,
  PolicyNodeType,
} from './workflow.ts'

/**
 * Every workflow node is an instance of a block. A block declares what it reads from the
 * request, the outputs a request can leave through, and which blocks commonly follow each
 * output. The editor renders, connects and suggests nodes from this alone; what a check does
 * at runtime lives in `engine.ts`.
 */

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral' | 'accent'

export type BlockId =
  | 'trigger'
  | `if_${ConditionField}`
  | CheckType
  | 'allow'
  | 'block'
  | 'skip'
  | `approve_${ApprovalMethod}`

export type BlockGroup = 'Conditions' | 'Content' | 'Tool' | 'Device' | 'Session' | 'Outcome'

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
  | 'usage'
  | 'model'

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
  usage: 'Spend and requests counted by a limit',
  model: 'Model id',
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
  | { kind: 'limit' }
  /** The values of a condition block, edited with the picker for its field. */
  | { kind: 'condition' }
)

type Body<N> = N extends PolicyNode ? Omit<N, 'id' | 'position'> : never
/** A node without its id and position. */
export type NodeBody = Body<PolicyNode>

export type BlockSpec = {
  id: BlockId
  nodeType: PolicyNodeType
  group: BlockGroup
  /** Two or three plain words. */
  label: string
  /** One short sentence: what the block does. */
  description: string
  /** Where the data the block decides on comes from. */
  source: string
  /** Anything worth knowing beyond the one sentence; shown in the step settings only. */
  details?: string
  inputs: BlockInput[]
  /** The stages this block inspects; elsewhere it is skipped and leaves through `pass`. */
  appliesTo?: EventKind[]
  outputs: BlockOutput[]
  /** The output an inserted block continues the existing path through; null for outcomes. */
  through: string | null
  fields: BlockField[]
  create: () => NodeBody
  /** One line shown on the node. */
  summary: (node: PolicyNode) => string
}

const conditionLabels: Record<Condition['field'], string> = {
  kind: 'Stage',
  source: 'Source',
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
  confirm: 'User confirm',
  touchid: 'Touch ID',
  browser: 'Browser login',
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

/** Stages that come from the device: device and presence checks only apply to these. */
const requestStages: EventKind[] = ['model_request', 'tool_call', 'agent_message']

const pass = (label: string, next: BlockId[]): BlockOutput => ({
  id: 'pass',
  label,
  tone: 'ok',
  next,
})

type CheckOf<T extends CheckType> = Extract<CheckConfig, { type: T }>

function checkBlock<T extends CheckType>(
  type: T,
  spec: Pick<
    BlockSpec,
    'group' | 'label' | 'description' | 'source' | 'details' | 'inputs' | 'outputs' | 'appliesTo'
  > & {
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
    source: spec.source,
    details: spec.details,
    inputs: spec.inputs,
    appliesTo: spec.appliesTo,
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

const conditionSpecs: Record<
  ConditionField,
  { label: string; description: string; source: string; inputs: BlockInput[] }
> = {
  kind: {
    label: 'Stage is',
    description:
      'Splits by stage: model input, tool call, tool result, model output or agent message.',
    source: 'The request',
    inputs: [],
  },
  tool: {
    label: 'Tool is',
    description: 'Matches the tool name. Use * as a wildcard: Bash, delete_*.',
    source: 'The request',
    inputs: ['tool'],
  },
  source: {
    label: 'Tool source is',
    description: 'Is the tool from an MCP server or built into the agent?',
    source: 'The request',
    inputs: ['tool'],
  },
  mcpServer: {
    label: 'MCP server is',
    description: 'Matches the MCP server the tool comes from.',
    source: 'The request',
    inputs: ['tool'],
  },
  tier: {
    label: 'Tool tier is',
    description: 'Is the tool read, write or destructive?',
    source: 'MCP tool annotations',
    inputs: ['tool'],
  },
  model: {
    label: 'Model is',
    description: 'Matches the model id. Use * as a wildcard: claude-opus-*.',
    source: 'The request',
    inputs: ['model'],
  },
  group: {
    label: 'User group is',
    description: 'Is the user in one of these groups?',
    source: 'Groups page',
    inputs: ['identity'],
  },
  resource: {
    label: 'Resource is',
    description: 'Does the tool belong to one of these resources?',
    source: 'Resources page',
    inputs: ['identity'],
  },
  deviceStatus: {
    label: 'Device is',
    description: 'Is the device trusted, new or a mismatch?',
    source: 'Device token, checked by the gateway',
    inputs: ['device'],
  },
  keyStorage: {
    label: 'Key storage is',
    description: 'Where does the device keep its key?',
    source: 'The device, sent by the plugin',
    inputs: ['key_storage'],
  },
}

/** One block per question. Yes and No chained into each other make AND and OR. */
function conditionBlocks(): BlockSpec[] {
  return (Object.keys(conditionSpecs) as ConditionField[]).map((field) => ({
    id: `if_${field}` as BlockId,
    nodeType: 'condition',
    group: 'Conditions',
    label: conditionSpecs[field].label,
    description: conditionSpecs[field].description,
    source: conditionSpecs[field].source,
    details: 'Chain Yes into the next condition for AND, No for OR.',
    inputs: conditionSpecs[field].inputs,
    outputs: [
      {
        id: 'yes',
        label: 'Yes',
        tone: 'accent',
        next: ['keywords', 'arguments', 'judge', 'approve_touchid', 'block'],
      },
      { id: 'no', label: 'No', tone: 'neutral', next: ['skip', 'allow', 'if_tool', 'keywords'] },
    ],
    through: 'yes',
    fields: [{ kind: 'condition', key: 'condition', label: 'Values' }],
    create: () => ({ type: 'condition', condition: { field, values: [] } as Condition }),
    summary: (node) =>
      node.type !== 'condition' || node.condition.values.length === 0
        ? 'No values yet'
        : conditionText(node.condition).replace(/^[^:]+: /, ''),
  }))
}

const reasonField: BlockField = {
  kind: 'text',
  key: 'reason',
  label: 'Reason',
  hint: 'Shown to the user and in the approval queue.',
}

function approvalBlock(
  method: ApprovalMethod,
  description: string,
  source: string,
  wait: string,
  details?: string,
): BlockSpec {
  return {
    id: `approve_${method}`,
    nodeType: 'decision',
    group: 'Outcome',
    label: approvalLabels[method],
    description,
    source,
    details,
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
    group: 'Conditions',
    label: 'Start',
    description: 'Picks which stages run this guardrail.',
    source: 'The request',
    details:
      'Picks the stages this guardrail runs on. None ticked: every stage (model input, tool calls, tool results, model output and agent messages). Ask about tools, models or groups with condition blocks after it; a request that ends in Skip, or starts no workflow, is allowed.',
    inputs: [],
    outputs: [
      {
        id: 'next',
        label: 'Next',
        tone: 'accent',
        next: ['if_tool', 'if_model', 'fingerprint', 'keywords'],
      },
    ],
    through: 'next',
    fields: [
      {
        kind: 'multi',
        key: 'stages',
        label: 'Runs on',
        hint: 'None ticked runs on every stage.',
        options: eventKind.options.map((value) => ({ value, label: kindLabels[value] })),
      },
    ],
    create: () => ({ type: 'trigger', stages: [] }),
    summary: (node) =>
      node.type !== 'trigger' || node.stages.length === 0
        ? 'Any stage'
        : node.stages.map((k) => kindLabels[k]).join(', '),
  },
  ...conditionBlocks(),
  checkBlock('fingerprint', {
    group: 'Device',
    appliesTo: requestStages,
    label: 'Device check',
    description: 'Is this the device the token was issued to?',
    source: 'Device token, checked by the gateway',
    details:
      'Compares the device presenting the token with the one it was issued to. Approving a request that came through New device also trusts that device.',
    inputs: ['device'],
    outputs: [
      pass('Known device', ['keywords', 'posture', 'judge', 'redact', 'if_tool']),
      {
        id: 'new',
        label: 'New device',
        tone: 'warn',
        next: ['approve_admin', 'keywords', 'approve_browser', 'block'],
      },
      { id: 'mismatch', label: 'Wrong device', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    defaults: { type: 'fingerprint' },
    summary: () => 'Known, new or copied device',
  }),
  checkBlock('posture', {
    group: 'Device',
    appliesTo: requestStages,
    label: 'EDR score',
    description: 'Reads the device health score.',
    source: 'CrowdStrike, sent by the plugin',
    details:
      'Reads the CrowdStrike Zero Trust score for the device. A raised detection or a contained host leaves through Compromised; a stale, missing or unconfirmed score through Unknown.',
    inputs: ['posture'],
    outputs: [
      pass('Healthy', ['os_posture', 'network', 'keywords', 'if_tool']),
      {
        id: 'low',
        label: 'Low score',
        tone: 'warn',
        next: ['if_tool', 'block', 'approve_browser'],
      },
      { id: 'compromised', label: 'Compromised', tone: 'bad', next: ['block'] },
      {
        id: 'unknown',
        label: 'Unknown',
        tone: 'warn',
        next: ['approve_browser', 'if_tool', 'block'],
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
    appliesTo: requestStages,
    label: 'OS security',
    description: 'Checks disk encryption, SIP, Gatekeeper and firewall.',
    source: 'The device, sent by the plugin',
    details:
      'Built-in checks the device reports about itself. A baseline for machines without an EDR; fails when a required protection is off.',
    inputs: ['os_posture'],
    outputs: [
      pass('All on', ['network', 'keywords', 'if_tool']),
      {
        id: 'fail',
        label: 'Protection off',
        tone: 'bad',
        next: ['block', 'if_tool', 'approve_browser'],
      },
    ],
    fields: [{ kind: 'multi', key: 'require', label: 'Must be on', options: osPostureOptions }],
    defaults: { type: 'os_posture', require: ['fv', 'sip'] },
    summary: (c) => c.require.join(', ') || 'nothing required',
  }),
  checkBlock('network', {
    group: 'Device',
    appliesTo: requestStages,
    label: 'Network check',
    description: 'Flags a new network or impossible travel.',
    source: 'Request IP, checked by the gateway',
    details:
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
    label: 'Keyword match',
    description: 'Looks for your words or patterns in the text.',
    source: 'Your pattern list',
    inputs: ['content'],
    outputs: [
      pass('No match', ['signatures', 'learned', 'judge', 'redact']),
      { id: 'fail', label: 'Match', tone: 'bad', next: ['block', 'approve_admin', 'judge'] },
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
  checkBlock('signatures', {
    group: 'Content',
    label: 'Known attacks',
    description: 'Matches known bad packages, commands and code.',
    source: 'Built-in list and the signature feed',
    details:
      'Matches the request against signatures of attacks that already happened: code execution, unsafe deserialization, malicious packages and model-repository exploits, tool poisoning. Uses the built-in baseline plus the external signature feed, and sees through base64 and Unicode tricks.',
    inputs: ['content'],
    outputs: [
      pass('No match', ['judge', 'redact', 'untrusted_content', 'allow']),
      { id: 'fail', label: 'Match', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    fields: [
      {
        kind: 'select',
        key: 'minSeverity',
        label: 'Strictness',
        hint: 'Signatures below this severity are ignored.',
        options: [
          { value: 'low', label: 'Low and above (strictest)' },
          { value: 'medium', label: 'Medium and above' },
          { value: 'high', label: 'High and above' },
          { value: 'critical', label: 'Critical only' },
        ],
      },
      {
        kind: 'multi',
        key: 'categories',
        label: 'Categories',
        hint: 'Leave all unchecked to match every category.',
        options: [
          { value: 'code_execution', label: 'Code execution' },
          { value: 'deserialization', label: 'Unsafe deserialization' },
          { value: 'supply_chain', label: 'Supply chain and model repositories' },
          { value: 'destructive_command', label: 'Destructive commands' },
          { value: 'exfiltration', label: 'Exfiltration' },
          { value: 'prompt_injection', label: 'Prompt injection' },
          { value: 'tool_poisoning', label: 'Tool poisoning' },
          { value: 'agent_tampering', label: 'Agent tampering' },
        ],
      },
    ],
    defaults: { type: 'signatures', minSeverity: 'medium', categories: [] },
    summary: (c) =>
      `${c.minSeverity}+ · ${c.categories.length ? `${c.categories.length} categories` : 'all categories'}`,
  }),
  checkBlock('learned', {
    group: 'Content',
    label: 'Trained model',
    description: 'Flags requests that look like attacks in your datasets.',
    source: 'Datasets you pick',
    details:
      'Flags requests that look like the attacks in the datasets you pick. Select datasets and train: a small model learns them in seconds and scores each request in well under a millisecond. It only knows what it was trained on.',
    inputs: ['content'],
    outputs: [
      pass('No match', ['judge', 'redact', 'allow']),
      {
        id: 'fail',
        label: 'Looks like attack',
        tone: 'bad',
        next: ['block', 'approve_admin', 'judge'],
      },
    ],
    fields: [
      {
        kind: 'number',
        key: 'threshold',
        label: 'Flag at score ≥',
        hint: 'Lower catches more and blocks more benign requests.',
        min: 0.05,
        max: 0.99,
        step: 0.05,
      },
    ],
    defaults: { type: 'learned', threshold: 0.5, datasets: [], models: [] },
    summary: (c) =>
      c.models.length === 0
        ? 'Not trained yet'
        : `${c.datasets.length} ${c.datasets.length === 1 ? 'dataset' : 'datasets'} · score ≥ ${c.threshold}`,
  }),
  checkBlock('judge', {
    group: 'Content',
    label: 'LLM judge',
    description: 'Asks a model to rate the risk from 0 to 1.',
    source: 'The model endpoint you set',
    details:
      'Sends the input to a model on OpenRouter, or to any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM), and asks for a risk score between 0 and 1. When the judge is down or times out, the guardrail fallback decides.',
    inputs: ['content', 'tool'],
    outputs: [
      pass('Low risk', ['redact', 'allow', 'untrusted_content']),
      {
        id: 'fail',
        label: 'High risk',
        tone: 'bad',
        next: ['block', 'approve_admin', 'approve_touchid'],
      },
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
    label: 'Redact data',
    description: 'Hides secrets and personal data from the model.',
    source: 'Built-in detectors',
    details:
      'Replaces secrets and personal data with stable placeholders like [REDACTED_EMAIL_1] before they reach the model, and in MCP tool results. When the agent passes a placeholder back into a tool call, the gateway swaps the real value in. Never blocks.',
    inputs: ['content'],
    outputs: [pass('Next', ['allow', 'judge', 'keywords'])],
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
    appliesTo: ['tool_call'],
    label: 'Argument rules',
    description: 'Checks tool arguments against your rules.',
    source: 'Your rules',
    details:
      'Refuses a tool call when an argument does not match its allowed pattern, for example email_send may only send to @company.com.',
    inputs: ['tool', 'arguments'],
    outputs: [
      pass('OK', ['untrusted_content', 'approve_confirm', 'allow']),
      { id: 'fail', label: 'Rule broken', tone: 'bad', next: ['block', 'approve_admin'] },
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
    appliesTo: ['tool_call'],
    label: 'Tool pin',
    description: 'Checks the tool is the one an admin approved.',
    source: 'Pinned tool definitions, sent by the plugin',
    details:
      'Compares the tool with the definition an admin pinned. A changed name, description or schema is how tool poisoning and rug pulls arrive.',
    inputs: ['definition'],
    outputs: [
      pass('Same', ['arguments', 'untrusted_content', 'allow']),
      { id: 'changed', label: 'Changed', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    defaults: { type: 'tool_pinning' },
    summary: () => 'Same definition as pinned',
  }),
  checkBlock('untrusted_content', {
    group: 'Session',
    appliesTo: ['model_request', 'tool_call'],
    label: 'Untrusted input',
    description: 'Did the session read outside content recently?',
    source: 'Session history, sent by the plugin',
    details:
      'Prompt-injection guard. After the session reads untrusted content (a web page, an inbox, a ticket), requests leave through Recently read for the length of the window.',
    inputs: ['untrusted'],
    outputs: [
      pass('Clean', ['allow', 'redact', 'approve_confirm']),
      {
        id: 'tainted',
        label: 'Read recently',
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
    appliesTo: ['tool_call'],
    label: 'Hook check',
    description: 'Did Claude Code start this tool call?',
    source: 'Claude Code hook, sent by the plugin',
    details:
      "Checks that Claude Code's own hook recorded this exact tool call. A call without a record came from something else holding the session.",
    inputs: ['hook'],
    outputs: [
      pass('From Claude Code', ['idle', 'untrusted_content', 'allow']),
      {
        id: 'fail',
        label: 'No record',
        tone: 'warn',
        next: ['approve_touchid', 'approve_browser', 'block'],
      },
    ],
    defaults: { type: 'hook' },
    summary: () => 'Tool call matches a hook record',
  }),
  checkBlock('idle', {
    group: 'Session',
    appliesTo: requestStages,
    label: 'User present',
    description: 'Is someone at the keyboard?',
    source: 'Device idle time, sent by the plugin',
    details:
      'Uses keyboard and mouse idle time on the device. An agent acting while nobody is there is worth a second look.',
    inputs: ['idle'],
    outputs: [
      pass('Present', ['untrusted_content', 'allow', 'redact']),
      {
        id: 'idle',
        label: 'Away',
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
  checkBlock('limit', {
    group: 'Session',
    label: 'Usage limit',
    description: 'Checks spend or usage against a limit.',
    source: 'A rule from the Limits page',
    details:
      'Reads a rule from the Limits page set to "let the guardrail decide": spend in USD, tokens, GPU time or requests for the user, their group or the org. Under the warning level the request passes; past it, it leaves through Near limit; past the limit, through Over limit.',
    inputs: ['usage', 'identity'],
    appliesTo: ['model_request', 'tool_call', 'agent_message'],
    outputs: [
      pass('Under limit', ['keywords', 'allow', 'if_tool']),
      { id: 'warn', label: 'Near limit', tone: 'warn', next: ['allow', 'approve_confirm'] },
      { id: 'over', label: 'Over limit', tone: 'bad', next: ['block', 'approve_admin'] },
    ],
    fields: [{ kind: 'limit', key: 'limitId', label: 'Limit' }],
    defaults: { type: 'limit', limitId: '' },
    summary: (c) => (c.limitId ? 'Usage against a limit' : 'No limit selected'),
  }),
  {
    id: 'allow',
    nodeType: 'decision',
    group: 'Outcome',
    label: 'Allow',
    description: 'Sends the request on.',
    source: '—',
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
    summary: () => 'Send the request on',
  },
  approvalBlock(
    'admin',
    'Waits for an admin to approve in the dashboard.',
    'An admin, in the dashboard',
    'Wait for an admin',
  ),
  approvalBlock(
    'confirm',
    'Asks the user to confirm in Claude Code.',
    'The user, reported by the plugin',
    'Ask in Claude Code',
    'The lightest level: the device reports the answer and the gateway cannot verify it.',
  ),
  approvalBlock(
    'touchid',
    'Asks the user to approve with Touch ID.',
    'Touch ID proof, sent by the plugin',
    'Wait for Touch ID',
    'The proof covers this exact request. Devices without Touch ID are sent to the browser instead.',
  ),
  approvalBlock(
    'browser',
    'Asks the user to sign in again and approve.',
    'A fresh sign-in in the browser',
    'Wait for a fresh sign-in',
    "Only the device's owner can approve, and the approval covers this exact action.",
  ),
  {
    id: 'block',
    nodeType: 'decision',
    group: 'Outcome',
    label: 'Block',
    description: 'Stops the request.',
    source: '—',
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
    summary: (node) => (node.type === 'decision' && node.reason) || 'Stop the request',
  },
  {
    id: 'skip',
    nodeType: 'decision',
    group: 'Outcome',
    label: 'Skip',
    description: 'Ends this guardrail with no decision.',
    source: '—',
    details:
      'End this guardrail without a decision. It does not count towards the outcome, as if it had not started; other guardrails still decide.',
    inputs: [],
    outputs: [],
    through: null,
    fields: [],
    create: () => ({
      type: 'decision',
      action: 'skip',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    }),
    summary: () => 'This guardrail does not apply',
  },
]

export const blocks = Object.fromEntries(specs.map((b) => [b.id, b])) as Record<BlockId, BlockSpec>

/** Everything that can be added to a workflow, in display order. */
export const palette: BlockSpec[] = specs.filter((b) => b.id !== 'trigger')

export function blockId(node: PolicyNode): BlockId {
  switch (node.type) {
    case 'trigger':
      return 'trigger'
    case 'condition':
      return `if_${node.condition.field}`
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
  condition: 'Condition',
  decision: 'Decision',
}
