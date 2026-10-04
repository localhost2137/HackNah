import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from './cn.ts'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'ui-button-raised ui-button-primary border border-black/25 bg-accent text-white hover:bg-accent-hover',
        secondary: 'ui-button-raised border border-black/40 bg-panel-2 text-fg hover:bg-[#2d2e34]',
        ghost: 'text-muted hover:bg-panel-2 hover:text-fg',
        danger: 'ui-button-raised border border-black/25 bg-bad/90 text-white hover:bg-bad',
        success: 'ui-button-raised border border-black/25 bg-ok/90 text-black hover:bg-ok',
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-9 px-3.5',
        icon: 'size-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
}

const fieldClass =
  'ui-field w-full rounded-lg border border-line-strong bg-bg/70 px-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/10 focus:outline-none disabled:opacity-60'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea className={cn(fieldClass, 'min-h-20 py-2 font-mono text-xs', className)} {...props} />
  )
}

export function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(fieldClass, 'ui-select h-9 appearance-none pr-9', className)}
      {...props}
    />
  )
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('text-xs font-medium text-fg/85', className)} {...props} />
}

export function Field({
  label,
  hint,
  children,
  className,
  group,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  /**
   * Set when the field holds several controls (checkboxes, a list of rows). A `<label>` hands
   * every click inside it to its first control, so a group gets a plain container instead.
   */
  group?: boolean
}) {
  const content = (
    <>
      <span className="text-xs font-medium text-fg/85">{label}</span>
      {children}
      {hint ? <span className="text-xs leading-relaxed text-muted">{hint}</span> : null}
    </>
  )
  return group ? (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be a flex container in every browser
    <div role="group" aria-label={label} className={cn('flex flex-col gap-1.5', className)}>
      {content}
    </div>
  ) : (
    <label className={cn('flex flex-col gap-1.5', className)}>{content}</label>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'ui-switch relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.35)] transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

const badgeVariants = cva(
  'ui-badge inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium leading-none whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-panel-2 text-muted ring-1 ring-line ring-inset',
        accent: 'bg-accent-soft text-accent-strong',
        ok: 'bg-ok-soft text-ok',
        warn: 'bg-warn-soft text-warn',
        bad: 'bg-bad-soft text-bad',
        info: 'bg-info-soft text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export function Badge({
  className,
  tone,
  dot,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {props.children}
    </span>
  )
}

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('ui-surface rounded-xl border border-line bg-panel', className)}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'ui-card-header flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h3>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Stat({
  label,
  value,
  delta,
  tone = 'neutral',
}: {
  label: string
  value: React.ReactNode
  delta?: React.ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'bad'
}) {
  const toneClass = { neutral: 'text-fg', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone]
  return (
    <Card className="stat-card px-5 py-5">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div
        className={cn(
          'mt-3 text-[28px] font-medium leading-none tracking-[-0.04em] tabular-nums',
          toneClass,
        )}
      >
        {value}
      </div>
      {delta ? <div className="mt-1.5 text-xs text-subtle">{delta}</div> : null}
    </Card>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center ui-empty-state gap-2 px-6 py-16 text-center">
      <span className="ui-empty-icon mb-3" aria-hidden="true">
        <svg
          aria-hidden="true"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <rect x="4" y="3" width="16" height="18" rx="3" />
          <path d="M8 8h8M8 12h5M8 16h3" strokeLinecap="round" />
        </svg>
      </span>
      <div className="text-sm font-semibold text-fg">{title}</div>
      {description ? (
        <div className="max-w-sm text-[13px] leading-relaxed text-muted">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  details,
  actions,
}: {
  title: string
  description?: React.ReactNode
  details?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="ui-page-header flex flex-wrap items-start justify-between gap-x-8 gap-y-4 pb-7">
      <div className="min-w-0 flex-[1_1_360px]">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-fg">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
        {details ? (
          <details className="ui-page-details mt-2 max-w-3xl text-xs text-muted">
            <summary className="w-fit cursor-pointer rounded-sm py-1 hover:text-fg">
              How it works
            </summary>
            <div className="mt-2 rounded-lg border border-line bg-panel p-3 leading-relaxed">
              {details}
            </div>
          </details>
        ) : null}
      </div>
      {actions ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2 pt-0.5">
          {actions}
        </div>
      ) : null}
    </div>
  )
}

export function Mono({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('font-mono text-xs', className)} {...props} />
}
