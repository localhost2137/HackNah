import {
  approvalLabels,
  type BlockInput,
  blockOf,
  type DeviceStatus,
  type EvaluationInput,
  type EvaluationResult,
  evaluateGraph,
  type KeyStorage,
  type OsPostureKey,
  type PolicyGraph,
  type PostureStatus,
  type RequestSignals,
  type ToolTier,
} from '@acl/shared'
import { Badge, Button, Field, Input, Select, Textarea } from '@acl/ui'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { CheckList } from '#/components/event-bits.tsx'
import type { PickerOptions } from './inspector.tsx'
import { CheckboxGroup } from './step-form.tsx'

type Proof = 'none' | 'touchid' | 'no_touchid' | 'browser' | 'confirm'

type Form = {
  kind: EvaluationInput['kind']
  toolName: string
  mcpServerId: string
  model: string
  text: string
  deviceStatus: DeviceStatus
  groupIds: string[]
  resourceIds: string[]
  judgeScore: string
  tier: ToolTier
  keyStorage: KeyStorage
  postureStatus: PostureStatus
  postureScore: string
  osOff: OsPostureKey[]
  untrustedMinutes: string
  network: 'known' | 'new'
  travelKmh: string
  hook: 'yes' | 'no'
  idleMinutes: string
  definition: 'same' | 'changed'
  proof: Proof
}

const initial: Form = {
  kind: 'tool_call',
  toolName: 'Bash',
  mcpServerId: '',
  model: 'anthropic/claude-sonnet-4.5',
  text: '{"command":"ls -la"}',
  deviceStatus: 'trusted',
  groupIds: [],
  resourceIds: [],
  judgeScore: '0.2',
  tier: 'write',
  keyStorage: 'secure_enclave',
  postureStatus: 'ok',
  postureScore: '85',
  osOff: [],
  untrustedMinutes: '',
  network: 'known',
  travelKmh: '',
  hook: 'yes',
  idleMinutes: '0',
  definition: 'same',
  proof: 'none',
}

const decisionTone = { allow: 'ok', block: 'bad', pending: 'warn' } as const

const osProtections: { value: OsPostureKey; label: string }[] = [
  { value: 'fv', label: 'FileVault' },
  { value: 'sip', label: 'SIP' },
  { value: 'gk', label: 'Gatekeeper' },
  { value: 'fw', label: 'Firewall' },
]

const number = (text: string) =>
  text.trim() && Number.isFinite(Number(text)) ? Number(text) : null

function signalsOf(form: Form): RequestSignals {
  return {
    keyStorage: form.keyStorage,
    presenceVerified: form.proof === 'touchid',
    presenceCapable: form.proof !== 'no_touchid',
    approvedChallenge: form.proof === 'browser',
    confirmed: form.proof === 'confirm',
    ipKnown: form.network === 'known',
    travelKmh: number(form.travelKmh),
    untrustedContentMinutesAgo: number(form.untrustedMinutes),
    untrustedSource: 'example.com (WebFetch)',
    hookCorrelated: form.hook === 'yes',
    userIdleMinutes: number(form.idleMinutes),
    postureStatus: form.postureStatus,
    postureScore: number(form.postureScore),
    osPosture: Object.fromEntries(
      osProtections.map((p) => [p.value, !form.osOff.includes(p.value)]),
    ),
    definitionChanged: form.definition === 'changed',
  }
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Runs the graph in the browser against a made-up request. The judge is simulated. */
export function DryRun({
  graph,
  options,
  onResult,
}: {
  graph: PolicyGraph
  options: PickerOptions
  onResult: (r: EvaluationResult | null) => void
}) {
  const [form, setForm] = useState(initial)
  const [result, setResult] = useState<EvaluationResult | null>(null)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  // Only ask for the signals the blocks in this graph read.
  const reads = new Set<BlockInput>(graph.nodes.flatMap((n) => blockOf(n).inputs))
  const routesOn = (field: string) =>
    graph.nodes.some((n) => n.type === 'match' && n.conditions.some((c) => c.field === field))

  const run = async () => {
    const score = form.judgeScore.trim() ? Number(form.judgeScore) : Number.NaN
    const toolCall = form.kind === 'tool_call'
    const r = await evaluateGraph(
      graph,
      {
        kind: form.kind,
        text: form.text,
        toolName: toolCall ? form.toolName : null,
        mcpServerId: toolCall ? form.mcpServerId || null : null,
        model: toolCall ? null : form.model,
        deviceStatus: form.deviceStatus,
        groupIds: form.groupIds,
        resourceIds: form.resourceIds,
        toolTier: toolCall ? form.tier : null,
        toolArguments: toolCall ? parseArguments(form.text) : undefined,
        signals: signalsOf(form),
      },
      {
        judge: async () => {
          if (!Number.isFinite(score)) throw new Error('simulated outage')
          return { score, reason: 'Simulated judge verdict' }
        },
      },
    )
    setResult(r)
    onResult(r)
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value as Form['kind'])}>
            <option value="tool_call">Tool call</option>
            <option value="model_request">Prompt</option>
          </Select>
        </Field>
        <Field label="Device">
          <Select
            value={form.deviceStatus}
            onChange={(e) => set('deviceStatus', e.target.value as DeviceStatus)}
          >
            <option value="trusted">Trusted</option>
            <option value="new">New</option>
            <option value="mismatch">Mismatch</option>
          </Select>
        </Field>
        {form.kind === 'tool_call' ? (
          <>
            <Field label="Tool">
              <Input value={form.toolName} onChange={(e) => set('toolName', e.target.value)} />
            </Field>
            <Field label="MCP server">
              <Select value={form.mcpServerId} onChange={(e) => set('mcpServerId', e.target.value)}>
                <option value="">Built-in tool</option>
                {options.servers.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            {routesOn('tier') ? (
              <Field label="Tool tier" className="col-span-2">
                <Select value={form.tier} onChange={(e) => set('tier', e.target.value as ToolTier)}>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="destructive">Destructive</option>
                </Select>
              </Field>
            ) : null}
          </>
        ) : (
          <Field label="Model" className="col-span-2">
            <Input value={form.model} onChange={(e) => set('model', e.target.value)} />
          </Field>
        )}
      </div>
      <Field label={form.kind === 'tool_call' ? 'Arguments' : 'Prompt'}>
        <Textarea
          rows={3}
          className="font-mono text-[11px]"
          value={form.text}
          onChange={(e) => set('text', e.target.value)}
        />
      </Field>
      {options.groups.length > 0 ? (
        <Field label="User groups">
          <CheckboxGroup
            options={options.groups}
            value={form.groupIds}
            onChange={(v) => set('groupIds', v)}
          />
        </Field>
      ) : null}
      {options.resources.length > 0 ? (
        <Field label="Resources">
          <CheckboxGroup
            options={options.resources}
            value={form.resourceIds}
            onChange={(v) => set('resourceIds', v)}
          />
        </Field>
      ) : null}
      {graph.nodes.some((n) => n.type === 'check' && n.check.type === 'judge') ? (
        <Field
          label="Judge risk score"
          hint="What a judge node would return. Leave empty to simulate an outage."
        >
          <Input value={form.judgeScore} onChange={(e) => set('judgeScore', e.target.value)} />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        {routesOn('keyStorage') ? (
          <Field label="Device key storage" className="col-span-2">
            <Select
              value={form.keyStorage}
              onChange={(e) => set('keyStorage', e.target.value as KeyStorage)}
            >
              <option value="secure_enclave">Secure Enclave</option>
              <option value="tpm">TPM</option>
              <option value="software">Software key</option>
            </Select>
          </Field>
        ) : null}
        {reads.has('posture') ? (
          <>
            <Field label="EDR posture">
              <Select
                value={form.postureStatus}
                onChange={(e) => set('postureStatus', e.target.value as PostureStatus)}
              >
                <option value="ok">OK</option>
                <option value="stale">Stale</option>
                <option value="missing">Missing</option>
                <option value="unknown">Unconfirmed</option>
                <option value="invalid">Invalid</option>
                <option value="compromised">Compromised</option>
              </Select>
            </Field>
            <Field label="Posture score">
              <Input
                value={form.postureScore}
                onChange={(e) => set('postureScore', e.target.value)}
              />
            </Field>
          </>
        ) : null}
        {reads.has('os_posture') ? (
          <Field label="OS protections turned off" className="col-span-2">
            <CheckboxGroup
              options={osProtections}
              value={form.osOff}
              onChange={(v) => set('osOff', v)}
            />
          </Field>
        ) : null}
        {reads.has('network') ? (
          <>
            <Field label="Network">
              <Select
                value={form.network}
                onChange={(e) => set('network', e.target.value as Form['network'])}
              >
                <option value="known">Known</option>
                <option value="new">New</option>
              </Select>
            </Field>
            <Field label="Travel speed (km/h)">
              <Input value={form.travelKmh} onChange={(e) => set('travelKmh', e.target.value)} />
            </Field>
          </>
        ) : null}
        {reads.has('untrusted') ? (
          <Field
            label="Untrusted content read (minutes ago)"
            hint="Leave empty if the session never read any."
            className="col-span-2"
          >
            <Input
              value={form.untrustedMinutes}
              onChange={(e) => set('untrustedMinutes', e.target.value)}
            />
          </Field>
        ) : null}
        {reads.has('hook') ? (
          <Field label="Claude Code hook record">
            <Select value={form.hook} onChange={(e) => set('hook', e.target.value as Form['hook'])}>
              <option value="yes">Found</option>
              <option value="no">Missing</option>
            </Select>
          </Field>
        ) : null}
        {reads.has('idle') ? (
          <Field label="User idle (minutes)">
            <Input value={form.idleMinutes} onChange={(e) => set('idleMinutes', e.target.value)} />
          </Field>
        ) : null}
        {reads.has('definition') ? (
          <Field label="Tool definition" className="col-span-2">
            <Select
              value={form.definition}
              onChange={(e) => set('definition', e.target.value as Form['definition'])}
            >
              <option value="same">Same as pinned</option>
              <option value="changed">Changed since pinned</option>
            </Select>
          </Field>
        ) : null}
        {reads.has('presence') ? (
          <Field
            label="Proof sent with the request"
            hint="What a device-side approval finds on the request."
            className="col-span-2"
          >
            <Select value={form.proof} onChange={(e) => set('proof', e.target.value as Proof)}>
              <option value="none">None</option>
              <option value="confirm">Confirmed in Claude Code</option>
              <option value="touchid">Touch ID proof</option>
              <option value="browser">Approved in the browser</option>
              <option value="no_touchid">None, and the device has no Touch ID</option>
            </Select>
          </Field>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={run}>
          <Play className="size-3.5" /> Run
        </Button>
        {result ? (
          <>
            <Badge tone={decisionTone[result.decision]} dot>
              {result.approvalMethod
                ? `needs ${approvalLabels[result.approvalMethod]}`
                : result.decision}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setResult(null)
                onResult(null)
              }}
            >
              Clear
            </Button>
          </>
        ) : null}
      </div>
      {result ? <CheckList checks={result.checks} /> : null}
    </div>
  )
}
