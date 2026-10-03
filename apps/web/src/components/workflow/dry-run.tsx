import {
  type DeviceStatus,
  type EvaluationInput,
  type EvaluationResult,
  evaluateGraph,
  type PolicyGraph,
} from '@acl/shared'
import { Badge, Button, Field, Input, Select, Textarea } from '@acl/ui'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { CheckList } from '#/components/event-bits.tsx'
import type { PickerOptions } from './inspector.tsx'
import { CheckboxGroup } from './step-form.tsx'

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
}

const decisionTone = { allow: 'ok', block: 'bad', pending: 'warn' } as const

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

  const run = async () => {
    const score = form.judgeScore.trim() ? Number(form.judgeScore) : Number.NaN
    const r = await evaluateGraph(
      graph,
      {
        kind: form.kind,
        text: form.text,
        toolName: form.kind === 'tool_call' ? form.toolName : null,
        mcpServerId: form.kind === 'tool_call' ? form.mcpServerId || null : null,
        model: form.kind === 'model_request' ? form.model : null,
        deviceStatus: form.deviceStatus,
        groupIds: form.groupIds,
        resourceIds: form.resourceIds,
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
      <Field
        label="Judge risk score"
        hint="What a judge node would return. Leave empty to simulate an outage."
      >
        <Input value={form.judgeScore} onChange={(e) => set('judgeScore', e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={run}>
          <Play className="size-3.5" /> Run
        </Button>
        {result ? (
          <>
            <Badge tone={decisionTone[result.decision]} dot>
              {result.decision === 'pending' ? 'needs approval' : result.decision}
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
