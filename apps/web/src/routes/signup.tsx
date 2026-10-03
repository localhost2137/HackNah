import { Button, Field, Input } from '@acl/ui'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FormError } from '#/components/auth-shell.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/signup')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: SignupPage,
})

function SignupPage() {
  const { redirect } = Route.useSearch()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    setPending(false)
    if (error) return setError(error.message ?? 'Sign up failed')
    await navigate({ to: '/onboarding', search: { redirect } })
  }

  return (
    <AuthShell title="Create your account">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input name="name" autoComplete="name" required />
        </Field>
        <Field label="Work email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters">
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create account'}
        </Button>
        <p className="text-center text-xs text-muted">
          Already have an account?{' '}
          <Link to="/login" search={{ redirect }} className="text-accent-strong hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
