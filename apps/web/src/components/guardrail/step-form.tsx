import type { ArgumentRule, BlockField } from '@acl/shared'
import { Button, Field, Input, Select, Switch, Textarea } from '@acl/ui'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'

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

type Values = Record<string, unknown>

/** Renders the settings a block declares. `value` is the check (or node) the keys address. */
export function FieldForm({
  fields,
  value,
  onChange,
  limits = [],
}: {
  fields: BlockField[]
  value: Values
  onChange: (patch: Values) => void
  /** Rules on the Limits page a Limit block can read. */
  limits?: { value: string; label: string }[]
}) {
  return (
    <>
      {fields.map((field) => {
        const current = value[field.key]
        const set = (next: unknown) => onChange({ [field.key]: next })
        switch (field.kind) {
          case 'switch':
            return (
              <label key={field.key} className="flex items-center gap-2 text-xs">
                <Switch checked={current === true} onCheckedChange={set} />
                {field.label}
              </label>
            )
          case 'text':
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  value={String(current ?? '')}
                  placeholder={field.placeholder}
                  onChange={(e) => set(e.target.value)}
                />
              </Field>
            )
          case 'longtext':
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Textarea
                  rows={4}
                  value={String(current ?? '')}
                  placeholder={field.placeholder}
                  onChange={(e) => set(e.target.value)}
                />
              </Field>
            )
          case 'lines':
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Lines value={(current as string[]) ?? []} onChange={set} />
              </Field>
            )
          case 'number':
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={Number(current ?? 0)}
                  onChange={(e) => set(Number(e.target.value))}
                />
              </Field>
            )
          case 'select':
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Select value={String(current ?? '')} onChange={(e) => set(e.target.value)}>
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          case 'multi':
            return (
              <Field group key={field.key} label={field.label} hint={field.hint}>
                <CheckboxGroup
                  options={field.options}
                  value={
                    field.allWhenEmpty && !(current as string[])?.length
                      ? field.options.map((o) => o.value)
                      : ((current as string[]) ?? [])
                  }
                  onChange={(next) => {
                    if (!field.allWhenEmpty) return set(next)
                    // At least one stays ticked; all ticked is stored as "all", so later
                    // additions are included.
                    if (next.length === 0) return
                    set(next.length === field.options.length ? [] : next)
                  }}
                />
              </Field>
            )
          case 'limit':
            return (
              <Field
                key={field.key}
                label={field.label}
                hint={
                  limits.length
                    ? 'Only limits set to "let the guardrail decide" are listed.'
                    : 'Add a limit set to "let the guardrail decide" on the Limits page first.'
                }
              >
                <Select value={String(current ?? '')} onChange={(e) => set(e.target.value)}>
                  <option value="">Choose a limit…</option>
                  {limits.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          case 'argument_rules':
            return (
              <Field group key={field.key} label={field.label} hint={field.hint}>
                <ArgumentRules value={(current as ArgumentRule[]) ?? []} onChange={set} />
              </Field>
            )
        }
        return null
      })}
    </>
  )
}

/** One entry per line. Keeps the text being typed so a trailing newline isn't swallowed. */
function Lines({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'))
  return (
    <Textarea
      rows={8}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split('\n').filter((l) => l.trim()))
      }}
    />
  )
}

function ArgumentRules({
  value,
  onChange,
}: {
  value: ArgumentRule[]
  onChange: (v: ArgumentRule[]) => void
}) {
  const update = (index: number, patch: Partial<ArgumentRule>) =>
    onChange(value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  return (
    <div className="flex flex-col gap-3">
      {value.map((rule, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity of their own
          key={i}
          className="flex flex-col gap-2 rounded-md border border-line p-3"
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Tool"
              placeholder="email_send"
              value={rule.tool}
              onChange={(e) => update(i, { tool: e.target.value })}
            />
            <Input
              aria-label="Argument"
              placeholder="to"
              value={rule.argument}
              onChange={(e) => update(i, { argument: e.target.value })}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label="Remove rule"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <Input
            aria-label="Pattern"
            className="font-mono"
            placeholder="@company\.com$"
            value={rule.pattern}
            onChange={(e) => update(i, { pattern: e.target.value })}
          />
          <Input
            aria-label="Message"
            placeholder="Message shown when refused (optional)"
            maxLength={200}
            value={rule.message}
            onChange={(e) => update(i, { message: e.target.value })}
          />
        </div>
      ))}
      <Button
        size="sm"
        onClick={() => onChange([...value, { tool: '*', argument: '', pattern: '', message: '' }])}
      >
        <Plus className="size-3.5" /> Add rule
      </Button>
    </div>
  )
}
