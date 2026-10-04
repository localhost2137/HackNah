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
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgb(120_148_248/0.12),transparent_60%)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex justify-center">
          <BrandLogo className="w-64" />
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
