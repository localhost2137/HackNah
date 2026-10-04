import { Card } from '@acl/ui'
import { ShieldCheck } from 'lucide-react'
import type * as React from 'react'

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgb(120_148_248/0.12),transparent_60%)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-fg">
          <span className="flex size-7 items-center justify-center rounded-md bg-accent text-white">
            <ShieldCheck className="size-4" />
          </span>
          <span className="text-sm font-semibold tracking-tight">AI Control Layer</span>
        </div>
        <Card className="p-6">
          <h1 className="text-base font-semibold">{title}</h1>
          {subtitle ? <p className="mt-1 text-xs text-muted">{subtitle}</p> : null}
          <div className="mt-5">{children}</div>
        </Card>
      </div>
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return <div className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">{message}</div>
}
