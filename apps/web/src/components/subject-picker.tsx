import { Input } from '@acl/ui'
import { Users, UsersRound } from 'lucide-react'
import { useMemo, useState } from 'react'

export type PickerOption = { type: 'user' | 'group'; id: string; label: string; sub?: string }

const key = (o: { type: string; id: string }) => `${o.type}:${o.id}`

export function SubjectPicker({
  options,
  value,
  onChange,
}: {
  options: PickerOption[]
  value: { type: 'user' | 'group'; id: string }[]
  onChange: (value: { type: 'user' | 'group'; id: string }[]) => void
}) {
  const [q, setQ] = useState('')
  const selected = useMemo(() => new Set(value.map(key)), [value])
  const filtered = options.filter((o) =>
    `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q.toLowerCase()),
  )

  const toggle = (o: PickerOption) =>
    onChange(
      selected.has(key(o))
        ? value.filter((v) => key(v) !== key(o))
        : [...value, { type: o.type, id: o.id }],
    )

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="Search people and groups"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {filtered.map((o) => {
          const Icon = o.type === 'group' ? UsersRound : Users
          return (
            <li key={key(o)}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-panel-2">
                <input
                  type="checkbox"
                  checked={selected.has(key(o))}
                  onChange={() => toggle(o)}
                  className="accent-[var(--color-accent)]"
                />
                <Icon className="size-3.5 text-muted" />
                <span className="flex-1 text-xs">{o.label}</span>
                {o.sub ? <span className="text-[11px] text-subtle">{o.sub}</span> : null}
              </label>
            </li>
          )
        })}
        {filtered.length === 0 ? (
          <li className="px-3 py-3 text-xs text-muted">No matches</li>
        ) : null}
      </ul>
    </div>
  )
}
