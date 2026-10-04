import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Mono,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { PolicyFileCard } from '#/components/policy-file-card.tsx'
import { dateTime, timeAgo } from '#/lib/format.ts'
import { getConnectInfo, listAuditLog } from '#/server/fns/settings.ts'
import { deleteSsoProvider, getSsoProvider, saveSsoProvider } from '#/server/fns/sso.ts'

const infoQuery = queryOptions({ queryKey: ['connect-info'], queryFn: () => getConnectInfo() })
const ssoQuery = queryOptions({ queryKey: ['sso'], queryFn: () => getSsoProvider() })
const auditQuery = infiniteQueryOptions({
  queryKey: ['audit-log'],
  queryFn: ({ pageParam }) => listAuditLog({ data: { cursor: pageParam } }),
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})

export const Route = createFileRoute('/_app/settings/')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(infoQuery),
      context.isAdmin ? context.queryClient.ensureQueryData(ssoQuery) : null,
    ]),
  component: SettingsPage,
})

function SettingsPage() {
  const { isAdmin } = Route.useRouteContext()
  const { data: info } = useQuery(infoQuery)

  return (
    <>
      <PageHeader
        title="Settings"
        description="Manage your gateway, sign-in, and policy configuration."
      />
      <Card className="mb-6 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-[13px] font-semibold">Gateway endpoint</h2>
          <p className="mt-1 text-xs text-muted">Connect your agents to this instance.</p>
        </div>
        <Mono className="max-w-full break-all rounded-lg border border-line bg-bg/60 px-3 py-2">
          {info?.gatewayUrl}
        </Mono>
      </Card>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <SsoCard />
        {isAdmin ? <PolicyFileCard /> : null}
      </div>
      <div className="mt-6">
        <AuditLog />
      </div>
    </>
  )
}

function SsoCard() {
  const qc = useQueryClient()
  const { data } = useQuery(ssoQuery)
  const [editing, setEditing] = useState(false)
  const provider = data?.provider ?? null
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['sso'] }),
      qc.invalidateQueries({ queryKey: ['audit-log'] }),
    ])

  const save = useMutation({
    mutationFn: (form: FormData) =>
      saveSsoProvider({
        data: {
          issuer: String(form.get('issuer')),
          domain: String(form.get('domain')),
          clientId: String(form.get('clientId')),
          clientSecret: String(form.get('clientSecret')),
        },
      }),
    onSuccess: async () => {
      setEditing(false)
      await refresh()
    },
  })
  const remove = useMutation({ mutationFn: () => deleteSsoProvider(), onSuccess: refresh })

  if (!data) return null
  return (
    <Card>
      <CardHeader
        title="Single sign-on (OIDC)"
        actions={provider ? <Badge tone="ok">Enabled</Badge> : <Badge>Off</Badge>}
      />
      <div className="flex flex-col gap-5 p-5 text-[13px]">
        <p className="text-muted">
          Members on this domain use SSO. Admins can also sign in with a password.
        </p>
        <Field label="Redirect URI" hint="Register this in your identity provider's app.">
          <Mono className="block break-all rounded-lg border border-line bg-bg/60 px-3 py-2.5">
            {data.callbackUrl}
          </Mono>
        </Field>
        {provider && !editing ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted">Issuer</dt>
              <dd className="min-w-0 break-all">
                <Mono>{provider.issuer}</Mono>
              </dd>
              <dt className="text-muted">Domain</dt>
              <dd className="min-w-0 break-all">
                <Mono>{provider.domain}</Mono>
              </dd>
              <dt className="text-muted">Client ID</dt>
              <dd className="min-w-0 break-all">
                <Mono>{provider.clientId}</Mono>
              </dd>
            </dl>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Turn off SSO
              </Button>
            </div>
          </>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate(new FormData(e.currentTarget))
            }}
          >
            <Field
              label="Issuer URL"
              hint="e.g. https://accounts.google.com or https://acme.okta.com"
            >
              <Input name="issuer" type="url" required defaultValue={provider?.issuer} />
            </Field>
            <Field label="Email domain">
              <Input
                name="domain"
                required
                placeholder="acme.com"
                defaultValue={provider?.domain}
              />
            </Field>
            <Field label="Client ID">
              <Input name="clientId" required defaultValue={provider?.clientId} />
            </Field>
            <Field label="Client secret">
              <Input name="clientSecret" type="password" required autoComplete="off" />
            </Field>
            <FormError message={save.error?.message ?? null} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {save.isPending ? 'Checking provider…' : 'Save'}
              </Button>
              {provider ? (
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </div>
    </Card>
  )
}

function AuditLog() {
  const audit = useInfiniteQuery(auditQuery)
  const items = audit.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="A history of changes to policy, access, and integrations."
      />
      {items.length === 0 && !audit.isLoading ? (
        <EmptyState
          title="Nothing yet"
          description="Policy, access and integration changes show up here."
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Who</TH>
              <TH>Action</TH>
              <TH>Details</TH>
            </tr>
          </THead>
          <TBody>
            {items.map((r) => (
              <TR key={r.seq}>
                <TD className="text-xs whitespace-nowrap text-muted" title={dateTime(r.createdAt)}>
                  {timeAgo(r.createdAt)}
                </TD>
                <TD className="text-xs">{r.actorName ?? r.actorEmail ?? 'system'}</TD>
                <TD>
                  <Mono>{r.action}</Mono>
                </TD>
                <TD
                  className="max-w-[360px] truncate font-mono text-[11px] text-subtle"
                  title={r.data ?? undefined}
                >
                  {r.target}
                  {r.data ? ` ${r.data}` : ''}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {audit.hasNextPage ? (
        <div className="border-t border-line p-2 text-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={audit.isFetchingNextPage}
            onClick={() => audit.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
