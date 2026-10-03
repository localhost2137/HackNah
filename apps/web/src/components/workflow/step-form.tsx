import type { EventKind, PiiKind, StepAction, WorkflowStep } from '@acl/shared'
import { Field, Input, Select, Switch, Textarea } from '@acl/ui'

const actions: { value: StepAction; label: string }[] = [
  { value: 'block', label: 'Block the request' },
  { value: 'require_approval', label: 'Require approval' },
  { value: 'log', label: 'Log only' },
]

const kinds: { value: EventKind; label: string }[] = [
  { value: 'model_request', label: 'Prompts' },
  { value: 'tool_call', label: 'Tool calls' },
]

const piiKinds: { value: PiiKind; label: string }[] = [
  { value: 'email', label: 'Email addresses' },
  { value: 'phone', label: 'Phone numbers' },
  { value: 'iban', label: 'IBANs' },
  { value: 'credit_card', label: 'Card numbers' },
  { value: 'ipv4', label: 'IP addresses' },
  { value: 'pesel', label: 'PESEL numbers' },
]

function ActionSelect({
  value,
  onChange,
}: {
  value: StepAction
  onChange: (v: StepAction) => void
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as StepAction)}>
      {actions.map((a) => (
        <option key={a.value} value={a.value}>
          {a.label}
        </option>
      ))}
    </Select>
  )
}

function CheckboxGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T[]
  onChange: (v: T[]) => void
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-1.5 text-xs text-fg">
          <input
            type="checkbox"
            className="accent-[var(--color-accent)]"
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))
            }
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}

export function StepForm({
  step,
  onChange,
}: {
  step: WorkflowStep
  onChange: (step: WorkflowStep) => void
}) {
  switch (step.type) {
    case 'fingerprint':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            Compares the device presenting the token with the one it was issued to, and flags
            machines the user hasn't used before.
          </p>
          <Field label="When the request comes from a new device">
            <ActionSelect
              value={step.onNewDevice}
              onChange={(onNewDevice) => onChange({ ...step, onNewDevice })}
            />
          </Field>
          <Field
            label="When the token is used from a different device"
            hint="This usually means the token was copied."
          >
            <ActionSelect
              value={step.onMismatch}
              onChange={(onMismatch) => onChange({ ...step, onMismatch })}
            />
          </Field>
        </div>
      )
    case 'keywords':
      return (
        <div className="flex flex-col gap-4">
          <Field
            label="Patterns"
            hint={
              step.mode === 'regex'
                ? 'One regular expression per line.'
                : 'One per line. Use * as a wildcard.'
            }
          >
            <Textarea
              rows={8}
              value={step.patterns.join('\n')}
              onChange={(e) =>
                onChange({ ...step, patterns: e.target.value.split('\n').filter((l) => l.trim()) })
              }
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Match mode">
              <Select
                value={step.mode}
                onChange={(e) =>
                  onChange({ ...step, mode: e.target.value as 'substring' | 'regex' })
                }
              >
                <option value="substring">Substring / wildcard</option>
                <option value="regex">Regular expression</option>
              </Select>
            </Field>
            <Field label="On match">
              <ActionSelect
                value={step.action}
                onChange={(action) => onChange({ ...step, action })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={step.caseSensitive}
              onCheckedChange={(caseSensitive) => onChange({ ...step, caseSensitive })}
            />
            Case sensitive
          </label>
          <Field label="Check">
            <CheckboxGroup
              options={kinds}
              value={step.appliesTo}
              onChange={(appliesTo) => onChange({ ...step, appliesTo })}
            />
          </Field>
        </div>
      )
    case 'judge':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            Sends the input to a model on OpenRouter, or to any OpenAI-compatible endpoint (vLLM,
            Ollama, LiteLLM), and asks for a risk score between 0 and 1.
          </p>
          <Field
            label="Endpoint"
            hint="Chat completions URL. OpenRouter uses the gateway's key; other hosts use JUDGE_API_KEY."
          >
            <Input
              value={step.endpoint}
              onChange={(e) => onChange({ ...step, endpoint: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Model">
              <Input
                value={step.model}
                onChange={(e) => onChange({ ...step, model: e.target.value })}
              />
            </Field>
            <Field label="Fail at risk ≥">
              <Input
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={step.threshold}
                onChange={(e) => onChange({ ...step, threshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={100}
                max={30000}
                value={step.timeoutMs}
                onChange={(e) => onChange({ ...step, timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="On high risk">
              <ActionSelect
                value={step.action}
                onChange={(action) => onChange({ ...step, action })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={step.failOpen}
              onCheckedChange={(failOpen) => onChange({ ...step, failOpen })}
            />
            Let requests through when the judge is down or times out
          </label>
          <Field
            label="Extra instructions"
            hint="Company-specific rules appended to the judge's system prompt."
          >
            <Textarea
              rows={4}
              value={step.instructions}
              onChange={(e) => onChange({ ...step, instructions: e.target.value })}
            />
          </Field>
          <Field label="Check">
            <CheckboxGroup
              options={kinds}
              value={step.appliesTo}
              onChange={(appliesTo) => onChange({ ...step, appliesTo })}
            />
          </Field>
        </div>
      )
    case 'redact':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            Replaces secrets and personal data with stable placeholders like [REDACTED_EMAIL_1]
            before they reach the model, and in MCP tool results. When the agent passes a
            placeholder back into a tool call, the gateway swaps the real value in, so the agent can
            still work with the data without seeing it. Never blocks.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={step.secrets}
              onCheckedChange={(secrets) => onChange({ ...step, secrets })}
            />
            Secrets (API keys, tokens, private keys, passwords)
          </label>
          <Field label="Personal data">
            <CheckboxGroup
              options={piiKinds}
              value={step.pii}
              onChange={(pii) => onChange({ ...step, pii })}
            />
          </Field>
        </div>
      )
  }
}

export function stepSummary(step: WorkflowStep): string {
  switch (step.type) {
    case 'fingerprint':
      return `New device: ${step.onNewDevice.replace('_', ' ')} · Mismatch: ${step.onMismatch.replace('_', ' ')}`
    case 'keywords':
      return `${step.patterns.length} patterns · ${step.action.replace('_', ' ')}`
    case 'judge':
      return `${step.model} · risk ≥ ${step.threshold} · ${step.action.replace('_', ' ')}`
    case 'redact':
      return (
        [step.secrets ? 'secrets' : null, ...step.pii].filter(Boolean).join(', ') ||
        'nothing selected'
      )
  }
}

export function newStep(type: WorkflowStep['type']): WorkflowStep {
  const id = `${type}-${Math.random().toString(36).slice(2, 7)}`
  switch (type) {
    case 'fingerprint':
      return { id, type, enabled: true, onNewDevice: 'require_approval', onMismatch: 'block' }
    case 'keywords':
      return {
        id,
        type,
        enabled: true,
        patterns: [],
        mode: 'substring',
        caseSensitive: false,
        appliesTo: ['model_request', 'tool_call'],
        action: 'block',
      }
    case 'judge':
      return {
        id,
        type,
        enabled: true,
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'anthropic/claude-haiku-4.5',
        threshold: 0.7,
        timeoutMs: 8000,
        failOpen: true,
        instructions: '',
        appliesTo: ['tool_call'],
        action: 'require_approval',
      }
    case 'redact':
      return {
        id,
        type,
        enabled: true,
        secrets: true,
        pii: ['email', 'phone', 'iban', 'credit_card'],
      }
  }
}
