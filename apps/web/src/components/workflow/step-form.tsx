import type { CheckConfig, CheckType, PiiKind } from '@acl/shared'
import { Field, Input, Select, Switch, Textarea } from '@acl/ui'

const piiKinds: { value: PiiKind; label: string }[] = [
  { value: 'email', label: 'Email addresses' },
  { value: 'phone', label: 'Phone numbers' },
  { value: 'iban', label: 'IBANs' },
  { value: 'credit_card', label: 'Card numbers' },
  { value: 'ipv4', label: 'IP addresses' },
  { value: 'pesel', label: 'PESEL numbers' },
]

export function CheckboxGroup<T extends string>({
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

export function CheckForm({
  check,
  onChange,
}: {
  check: CheckConfig
  onChange: (check: CheckConfig) => void
}) {
  switch (check.type) {
    case 'fingerprint':
      return (
        <p className="text-xs text-muted">
          Compares the device presenting the token with the one it was issued to. Requests leave
          through <span className="text-fg">pass</span> for a known device,{' '}
          <span className="text-fg">new device</span> for a machine the user hasn't used before, and{' '}
          <span className="text-fg">mismatch</span> when the token was copied to another machine.
          Approving a request that came through <span className="text-fg">new device</span> also
          trusts that device.
        </p>
      )
    case 'keywords':
      return (
        <div className="flex flex-col gap-4">
          <Field
            label="Patterns"
            hint={
              check.mode === 'regex'
                ? 'One regular expression per line. Any match leaves through fail.'
                : 'One per line. Use * as a wildcard. Any match leaves through fail.'
            }
          >
            <Textarea
              rows={8}
              value={check.patterns.join('\n')}
              onChange={(e) =>
                onChange({ ...check, patterns: e.target.value.split('\n').filter((l) => l.trim()) })
              }
            />
          </Field>
          <Field label="Match mode">
            <Select
              value={check.mode}
              onChange={(e) =>
                onChange({ ...check, mode: e.target.value as 'substring' | 'regex' })
              }
            >
              <option value="substring">Substring / wildcard</option>
              <option value="regex">Regular expression</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={check.caseSensitive}
              onCheckedChange={(caseSensitive) => onChange({ ...check, caseSensitive })}
            />
            Case sensitive
          </label>
        </div>
      )
    case 'judge':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">
            Sends the input to a model on OpenRouter, or to any OpenAI-compatible endpoint (vLLM,
            Ollama, LiteLLM), and asks for a risk score between 0 and 1. Leaves through{' '}
            <span className="text-fg">error</span> when the judge is down or times out.
          </p>
          <Field
            label="Endpoint"
            hint="Chat completions URL. OpenRouter uses the gateway's key; other hosts use JUDGE_API_KEY."
          >
            <Input
              value={check.endpoint}
              onChange={(e) => onChange({ ...check, endpoint: e.target.value })}
            />
          </Field>
          <Field label="Model">
            <Input
              value={check.model}
              onChange={(e) => onChange({ ...check, model: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Fail at risk ≥">
              <Input
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={check.threshold}
                onChange={(e) => onChange({ ...check, threshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <Input
                type="number"
                min={100}
                max={30000}
                value={check.timeoutMs}
                onChange={(e) => onChange({ ...check, timeoutMs: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field
            label="Extra instructions"
            hint="Company-specific rules appended to the judge's system prompt."
          >
            <Textarea
              rows={4}
              value={check.instructions}
              onChange={(e) => onChange({ ...check, instructions: e.target.value })}
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
            still work with the data without seeing it. Applies to requests whose path goes through
            this node; never blocks.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={check.secrets}
              onCheckedChange={(secrets) => onChange({ ...check, secrets })}
            />
            Secrets (API keys, tokens, private keys, passwords)
          </label>
          <Field label="Personal data">
            <CheckboxGroup
              options={piiKinds}
              value={check.pii}
              onChange={(pii) => onChange({ ...check, pii })}
            />
          </Field>
        </div>
      )
  }
}

export function checkSummary(check: CheckConfig): string {
  switch (check.type) {
    case 'fingerprint':
      return 'Known, new or copied device'
    case 'keywords':
      return `${check.patterns.length} patterns`
    case 'judge':
      return `${check.model} · risk ≥ ${check.threshold}`
    case 'redact':
      return (
        [check.secrets ? 'secrets' : null, ...check.pii].filter(Boolean).join(', ') ||
        'nothing selected'
      )
  }
}

export function newCheck(type: CheckType): CheckConfig {
  switch (type) {
    case 'fingerprint':
      return { type }
    case 'keywords':
      return { type, patterns: [], mode: 'substring', caseSensitive: false }
    case 'judge':
      return {
        type,
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'anthropic/claude-haiku-4.5',
        threshold: 0.7,
        timeoutMs: 8000,
        instructions: '',
      }
    case 'redact':
      return { type, secrets: true, pii: ['email', 'phone', 'iban', 'credit_card'] }
  }
}
