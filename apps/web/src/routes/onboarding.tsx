import { Button, Field, Input } from '@acl/ui'
import { createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FormError } from '#/components/auth-shell.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { getViewer } from '#/server/fns/viewer.ts'

export const Route = createFileRoute('/onboarding')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async () => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: '/login' })
    return { viewer }
  },
  component: Onboarding,
})

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

function Onboarding() {
  const { viewer } = Route.useRouteContext()
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function finish(orgId: string) {
    await authClient.organization.setActive({ organizationId: orgId })
    await router.invalidate()
    const safe = target?.startsWith('/') && !target.startsWith('//') ? target : '/'
    await navigate({ href: safe })
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = String(new FormData(e.currentTarget).get('name'))
    setPending(true)
    setError(null)
    const { data, error } = await authClient.organization.create({
      name,
      slug: `${slugify(name) || 'org'}-${Math.random().toString(36).slice(2, 6)}`,
    })
    setPending(false)
    if (error || !data) return setError(error?.message ?? 'Could not create organization')
    await finish(data.id)
  }

  return (
    <AuthShell
      title="Set up your organization"
      subtitle="Your organization owns the gateway policy, MCP connections and audit history."
    >
      {viewer.orgs.length > 0 ? (
        <div className="mb-5 flex flex-col gap-2">
          <div className="text-xs font-medium text-muted">Continue with</div>
          {viewer.orgs.map((o) => (
            <Button key={o.id} onClick={() => finish(o.id)} className="justify-between">
              <span>{o.name}</span>
              <span className="text-[11px] text-subtle">{o.role}</span>
            </Button>
          ))}
          <div className="my-2 h-px bg-line" />
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Organization name">
          <Input name="name" placeholder="Acme Inc." required />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    </AuthShell>
  )
}
