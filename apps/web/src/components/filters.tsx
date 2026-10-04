import { cn } from '@acl/ui'
import type * as React from 'react'

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: React.ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-line bg-bg p-0.5 shadow-[inset_0_1px_3px_rgb(0_0_0/0.3)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-full rounded px-2.5 text-xs font-medium transition-colors',
            value === o.value
              ? 'ui-segment-selected bg-panel-2 text-fg'
              : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-panel-2 pr-1 pl-2 text-xs">
      {label}
      <button
        type="button"
        onClick={onClear}
        className="rounded px-1 text-muted hover:text-fg"
        aria-label={`Clear ${label}`}
      >
        ✕
      </button>
    </span>
  )
}
