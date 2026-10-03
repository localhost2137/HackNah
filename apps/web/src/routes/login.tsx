import { Button, Field, Input } from '@acl/ui'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell, FormError } from '#/components/auth-shell.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    redirect: z.string().optional(),
    /** Set by the SSO callback when the identity provider sign-in fails. */
    error: z.string().optional(),
  }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect, error: ssoError } = Route.useSearch()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'password' | 'sso'>(ssoError ? 'sso' : 'password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(
    ssoError ? `Single sign-on failed (${ssoError.replaceAll('_', ' ')})` : null,
  )
  const [pending, setPending] = useState(false)
  // Only follow same-origin paths to avoid an open redirect.
  const target = redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/'

  function switchMode(next: 'password' | 'sso') {
    setError(null)
    setMode(next)
  }

  async function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    const { error } = await authClient.signIn.email({
      email,
      password: String(form.get('password')),
    })
    setPending(false)
    if (error?.status === 403) {
      setMode('sso')
      return setError(error.message ?? 'This instance requires single sign-on')
    }
    if (error) return setError(error.message ?? 'Sign in failed')
    await navigate({ href: target })
  }

  async function onSso(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    setError(null)
    const { error } = await authClient.signIn.sso({
      email,
      callbackURL: target,
      errorCallbackURL: '/login',
    })
    // On success the browser is already on its way to the identity provider.
    if (error) {
      setPending(false)
      setError(
        error.status === 404
          ? 'No single sign-on is set up for this email domain'
          : (error.message ?? 'Single sign-on failed'),
      )
    }
  }

  const emailField = (
    <Field label="Work email">
      <Input
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
    </Field>
  )

  return (
    <AuthShell title="Sign in" subtitle="Manage how your team's AI agents access tools and data.">
      {mode === 'password' ? (
        <form onSubmit={onPassword} className="flex flex-col gap-4">
          {emailField}
          <Field label="Password">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
          {import.meta.env.DEV ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEmail('admin@demo.test')
                setPassword('LocalDemo123!')
                setError(null)
              }}
            >
              Fill admin credentials
            </Button>
          ) : null}
          <Button onClick={() => switchMode('sso')}>Continue with SSO</Button>
          <p className="text-center text-xs text-muted">
            No account?{' '}
            <Link to="/signup" search={{ redirect }} className="text-accent-strong hover:underline">
              Create one
            </Link>
          </p>
        </form>
      ) : (
        <form onSubmit={onSso} className="flex flex-col gap-4">
          {emailField}
          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Redirecting…' : 'Continue with SSO'}
          </Button>
          <button
            type="button"
            className="text-center text-xs text-muted hover:text-fg"
            onClick={() => switchMode('password')}
          >
            Sign in with a password instead
          </button>
        </form>
      )}
    </AuthShell>
  )
}
