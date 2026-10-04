import { describe, expect, it } from 'vitest'
import balanced from '../../../policies/balanced.yaml?raw'
import permissive from '../../../policies/permissive.yaml?raw'
import strict from '../../../policies/strict.yaml?raw'
import { evaluateGuardrails } from './engine.ts'
import { defaultGuardrail } from './guardrail.ts'
import {
  ALL_MEMBERS,
  diffPolicy,
  limitKey,
  type PolicyFile,
  type PolicyState,
  parsePolicyYaml,
  policyToYaml,
  resolveGroups,
  toPolicyFile,
} from './policy-file.ts'

const files = { permissive, balanced, strict }
const examples = Object.keys(files) as (keyof typeof files)[]
const load = (name: keyof typeof files) => files[name]

function parsed(text: string): PolicyFile {
  const r = parsePolicyYaml(text)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.file
}

const groups = [
  { id: 'grp_default', name: 'Everyone', isDefault: true },
  { id: 'grp_ml', name: 'ML team', isDefault: false },
]

const state: PolicyState = {
  groups,
  guardrails: [
    {
      name: 'Default',
      description: 'Runs for every member and every request.',
      enabled: true,
      groupIds: ['grp_ml'],
      definition: defaultGuardrail,
    },
    { name: 'Never published', description: null, enabled: true, groupIds: [], definition: null },
  ],
  limits: [
    {
      id: 'lim_1',
      name: 'Team budget',
      measure: 'cost',
      scope: 'model',
      target: '*',
      limit: 50,
      windowSec: 604_800,
      per: 'group_total',
      groupId: 'grp_default',
      group: null,
      action: 'guardrail',
      warnAtPct: 80,
      enabled: true,
    },
  ],
  models: [],
}

describe('example policies', () => {
  it.each(examples)('%s.yaml parses and every guardrail can be published', (name) => {
    const file = parsed(load(name))
    expect(file.guardrails.length).toBeGreaterThan(2)
    expect(file.limits.length).toBeGreaterThan(2)
    expect(file.models.some((m) => m.kind === 'local' && m.apiFormat === 'openai')).toBe(true)
  })

  it('differ in strictness', async () => {
    const [permissive, , strict] = examples.map((n) => parsed(load(n)))
    const run = (file: PolicyFile, text: string) =>
      evaluateGuardrails(
        file.guardrails.map((w, i) => ({
          id: `wf${i}`,
          name: w.name,
          version: 1,
          groupIds: [],
          definition: w.definition,
        })),
        { kind: 'tool_call', text, toolName: 'Bash', deviceStatus: 'new', toolArguments: {} },
      )
    // A new device: permissive lets it work, strict holds it for an admin.
    expect((await run(permissive!, '{}')).decision).toBe('allow')
    expect((await run(strict!, '{}')).decision).not.toBe('allow')
  })
})

describe('example policies use condition blocks', () => {
  const all = () => examples.flatMap((n) => parsed(load(n)).guardrails)
  const byName = (name: keyof typeof files, guardrail: string) =>
    parsed(load(name)).guardrails.find((w) => w.name === guardrail)!
  const run = (w: PolicyFile['guardrails'][number], input: Record<string, unknown>) =>
    evaluateGuardrails(
      [{ id: 'wf', name: w.name, version: 1, groupIds: [], definition: w.definition }],
      { kind: 'tool_call', text: '{}', toolName: 'Bash', deviceStatus: 'trusted', ...input },
    )

  it('are written in the stage and condition format', () => {
    // Fresh YAML: no legacy start conditions or Route nodes for the upgrade to convert.
    for (const name of examples) {
      expect(load(name)).not.toMatch(/type: match|conditions:/)
    }
    const nodes = all().flatMap((w) => w.definition.nodes)
    expect(nodes.some((n) => n.type === 'condition')).toBe(true)
    expect(nodes.some((n) => n.type === 'decision' && n.action === 'skip')).toBe(true)
  })

  it('AND: balanced asks for Touch ID only for destructive tools from MCP servers', async () => {
    const w = byName('balanced', 'Destructive MCP tools')
    const destructiveMcp = {
      toolName: 'gh__delete_repo',
      mcpServerId: 'gh',
      toolTier: 'destructive',
    }
    expect((await run(w, destructiveMcp)).decision).toBe('pending')
    const r = await run(w, { ...destructiveMcp, toolTier: 'write' })
    expect(r.decision).toBe('allow')
    expect(r.guardrails[0]!.decision).toBe('skip')
  })

  it('OR: strict sends declared or obviously destructive tools to an admin', async () => {
    const w = byName('strict', 'Tool calls')
    const signals = { untrustedContentMinutesAgo: null }
    const declared = await run(w, { toolName: 'x__wipe', toolTier: 'destructive', signals })
    expect(declared.decision).toBe('pending')
    const named = await run(w, { toolName: 'db__drop_table', toolTier: 'write', signals })
    expect(named.decision).toBe('pending')
    const plain = await run(w, { toolName: 'db__list', toolTier: 'read', signals })
    expect(plain.decision).toBe('allow')
  })

  it('still imports a policy file written with start conditions and Route nodes', () => {
    const legacy = `version: 1
guardrails:
  - name: Old Bash rule
    definition:
      nodes:
        - { id: start, type: trigger, mode: all, conditions: [{ field: kind, values: [tool_call] }, { field: tool, values: [Bash] }] }
        - { id: block, type: decision, action: block }
      edges:
        - { id: e1, source: start, sourceHandle: next, target: block }
`
    const w = parsed(legacy).guardrails[0]!
    expect(w.definition.nodes.find((n) => n.type === 'trigger')).toMatchObject({
      stages: ['tool_call'],
    })
    expect(w.definition.nodes.some((n) => n.type === 'condition')).toBe(true)
  })
})

describe('policy file round trip', () => {
  it('exports names instead of ids and leaves out unpublished guardrails', () => {
    const file = toPolicyFile(state)
    expect(file.guardrails.map((w) => w.name)).toEqual(['Default'])
    expect(file.guardrails[0]!.groups).toEqual(['ML team'])
    expect(file.limits[0]).toMatchObject({ name: 'Team budget', group: ALL_MEMBERS })
    expect(file.limits[0]).not.toHaveProperty('id')
  })

  it('writes documented YAML that reads back to the same policy', () => {
    const file = toPolicyFile(state)
    const yaml = policyToYaml(file)
    expect(yaml).toContain('# Hack?Nah! policy file.')
    expect(yaml).toContain('# Limits, checked at the gateway')
    expect(yaml).toMatch(/position: \{ x: \d+, y: \d+ \}/)
    expect(diffPolicy(file, parsed(yaml), 'replace').every((c) => c.action === 'unchanged')).toBe(
      true,
    )
  })

  it('refers to limits by name in Usage limit blocks', () => {
    const graph = {
      ...defaultGuardrail,
      nodes: [
        ...defaultGuardrail.nodes,
        {
          id: 'budget',
          type: 'check' as const,
          position: { x: 0, y: 0 },
          enabled: true,
          check: { type: 'limit' as const, limitId: 'lim_1' },
        },
      ],
    }
    const file = toPolicyFile({
      ...state,
      guardrails: [{ ...state.guardrails[0]!, definition: graph }],
    })
    const node = file.guardrails[0]!.definition.nodes.find((n) => n.id === 'budget')
    expect(node).toMatchObject({ check: { limitId: 'Team budget' } })
  })
})

describe('parsePolicyYaml', () => {
  it('names the line and field of a schema error', () => {
    const r = parsePolicyYaml(
      [
        'version: 1',
        'limits:',
        '  - measure: cost',
        '    scope: model',
        '    target: "*"',
        '    limit: -5',
        '    windowSec: 60',
      ].join('\n'),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/^line 6, limits\[0\]\.limit: /)
  })

  it('reports YAML syntax errors with their line', () => {
    const r = parsePolicyYaml('version: 1\nguardrails: [\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/^line \d+: /)
  })

  it('refuses duplicates, unpublishable graphs and dangling limit references', () => {
    const r = parsePolicyYaml(`
version: 1
guardrails:
  - name: A
    definition:
      nodes:
        - { id: start, type: trigger }
        - { id: budget, type: check, check: { type: limit, limitId: Nope } }
        - { id: allow, type: decision, action: allow }
      edges:
        - { id: e1, source: start, sourceHandle: next, target: budget }
        - { id: e2, source: budget, sourceHandle: pass, target: allow }
  - name: A
    definition: { nodes: [], edges: [] }
`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join('\n')).toContain('"A" appears more than once')
      expect(r.errors.join('\n')).toContain('exactly one start node')
      expect(r.errors.join('\n')).toContain('refers to "Nope"')
    }
  })

  it('lays out nodes written without positions', () => {
    const file = parsed(load('balanced'))
    const positions = file.guardrails[0]!.definition.nodes.map((n) => n.position.x)
    expect(new Set(positions).size).toBeGreaterThan(1)
    expect(file.guardrails[0]!.definition.nodes[0]!.position).toEqual({ x: 0, y: 0 })
  })
})

describe('diffPolicy', () => {
  const current = toPolicyFile(state)

  it('creates, updates and in replace mode disables', () => {
    const next: PolicyFile = {
      ...current,
      guardrails: [
        {
          ...current.guardrails[0]!,
          definition: { ...current.guardrails[0]!.definition, fallback: 'allow' },
        },
        { ...current.guardrails[0]!, name: 'New one' },
      ],
      limits: [],
    }
    expect(diffPolicy(current, next, 'replace')).toEqual([
      { kind: 'guardrail', name: 'Default', action: 'update', fields: ['definition'] },
      { kind: 'guardrail', name: 'New one', action: 'create' },
      { kind: 'limit', name: 'Team budget', action: 'disable' },
    ])
    expect(diffPolicy(current, next, 'merge').some((c) => c.action === 'disable')).toBe(false)
  })

  it('ignores entries the other side does not have when comparing order', () => {
    const extra: PolicyFile = {
      ...current,
      guardrails: [{ ...current.guardrails[0]!, name: 'Old' }, ...current.guardrails],
    }
    expect(diffPolicy(extra, current, 'merge')).toEqual([
      { kind: 'guardrail', name: 'Default', action: 'unchanged' },
      { kind: 'limit', name: 'Team budget', action: 'unchanged' },
    ])
  })

  it('ignores node positions', () => {
    const moved: PolicyFile = {
      ...current,
      guardrails: current.guardrails.map((w) => ({
        ...w,
        definition: {
          ...w.definition,
          nodes: w.definition.nodes.map((n) => ({ ...n, position: { x: 1, y: 1 } })),
        },
      })),
    }
    expect(diffPolicy(current, moved, 'merge').map((c) => c.action)).toEqual([
      'unchanged',
      'unchanged',
    ])
  })
})

describe('resolveGroups', () => {
  it('knows the default group as All members and reports unknown names', () => {
    const file = parsed(load('balanced'))
    expect(resolveGroups(groups, file).unknown).toEqual([])
    expect(resolveGroups(groups, file).ids.get(ALL_MEMBERS)).toBe('grp_default')
    const extra = { ...file, guardrails: [{ ...file.guardrails[0]!, groups: ['Nobody'] }] }
    expect(resolveGroups(groups, extra).unknown).toEqual(['Nobody'])
    expect(limitKey(file.limits[0]!)).toBe('Daily spend per user')
  })
})
