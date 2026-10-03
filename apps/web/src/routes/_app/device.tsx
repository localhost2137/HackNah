import { Badge, Button, Card, Field, Input, PageHeader } from '@acl/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MonitorSmartphone } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { FormError } from '#/components/auth-shell.tsx'
import { timeAgo } from '#/lib/format.ts'
import { decideDeviceCode, lookupDeviceCode } from '#/server/fns/devices.ts'

/** Verification page for the plugin's device login (`verification_uri`). */
export const Route = createFileRoute('/_app/device')({
  validateSearch: z.object({ code: z.string().optional() }),
  component: DevicePage,
})

function DevicePage() {
  const { code } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [input, setInput] = useState(code ?? '')

  const lookup = useQuery({
    queryKey: ['device-code', code],
    queryFn: () => lookupDeviceCode({ data: { userCode: code! } }),
    enabled: Boolean(code && code.replace(/[^A-Za-z0-9]/g, '').length === 8),
    retry: false,
  })
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideDeviceCode({ data: { userCode: code!, approve } }),
  })

  return (
    <div className="mx-auto max-w-lg pt-10">
      <PageHeader
        title="Connect a device"
        description="Confirm the code shown by Claude Code to sign this machine in."
      />
      <Card className="p-5">
        {!code || lookup.data === null || lookup.isError ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              navigate({ search: { code: input.trim().toUpperCase() } })
            }}
          >
            <Field label="Code from Claude Code">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="ABCD-EFGH"
                className="font-mono text-base tracking-widest uppercase"
                autoFocus
              />
            </Field>
            <FormError
              message={
                code && (lookup.data === null || lookup.isError)
                  ? 'Code not found or expired.'
                  : null
              }
            />
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </form>
        ) : decide.data ? (
          <div className="text-sm">
            {decide.data.status === 'denied' ? (
              <p>Login denied. You can close this tab.</p>
            ) : decide.data.deviceStatus === 'pending' ? (
              <p>
                Device connected. Because you already use another machine, an administrator has to
                approve this one; your first request from it will wait in the approvals queue.
              </p>
            ) : (
              <p>
                Device connected. Return to Claude Code; it will pick up the login automatically.
              </p>
            )}
          </div>
        ) : lookup.data ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-md border border-line bg-panel-2 p-3">
              <MonitorSmartphone className="mt-0.5 size-5 text-muted" />
              <div className="text-xs">
                <div className="text-sm font-medium text-fg">{lookup.data.label}</div>
                <div className="text-muted">
                  {lookup.data.platform ?? 'unknown platform'} · {lookup.data.ip ?? 'unknown IP'}
                  {lookup.data.country ? ` (${lookup.data.country})` : ''}
                </div>
                <div className="mt-1 font-mono text-subtle">{lookup.data.userCode}</div>
                <div className="mt-2">
                  {lookup.data.knownDevice ? (
                    <Badge tone="ok">Known device: {lookup.data.knownDevice.label}</Badge>
                  ) : (
                    <Badge tone="warn">New device</Badge>
                  )}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted">
              Only approve if you started this login yourself, just now. Code expires{' '}
              {timeAgo(lookup.data.expiresAt)}.
            </p>
            <FormError message={decide.error?.message ?? null} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => decide.mutate(false)}
                disabled={decide.isPending}
              >
                Deny
              </Button>
              <Button
                variant="primary"
                onClick={() => decide.mutate(true)}
                disabled={decide.isPending}
              >
                Approve login
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted">Looking up code…</div>
        )}
      </Card>
    </div>
  )
}
