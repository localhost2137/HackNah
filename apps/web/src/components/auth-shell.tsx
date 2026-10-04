import { Card } from '@acl/ui'
import type * as React from 'react'
import { BrandLogo } from './brand-logo.tsx'

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
    <div className="auth-shell flex min-h-screen items-center justify-center bg-bg px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex justify-center">
          <BrandLogo className="w-40 grayscale brightness-150" />
        </div>
        <Card className="auth-card border-line-strong bg-panel p-8">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{subtitle}</p>
          ) : null}
          <div className="mt-7">{children}</div>
        </Card>
      </div>
    </div>
  )
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return <div className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">{message}</div>
}
