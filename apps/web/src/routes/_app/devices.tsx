import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { timeAgo } from '#/lib/format.ts'
import { listDevices, setDeviceStatus } from '#/server/fns/devices.ts'

const devicesQuery = queryOptions({ queryKey: ['devices'], queryFn: () => listDevices() })

export const Route = createFileRoute('/_app/devices')({
  loader: ({ context }) => context.queryClient.ensureQueryData(devicesQuery),
  component: DevicesPage,
})

const statusTone = { trusted: 'ok', pending: 'warn', revoked: 'bad' } as const

function DevicesPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data = [] } = useQuery(devicesQuery)
  const mutate = useMutation({
    mutationFn: (args: { id: string; status: 'trusted' | 'revoked' }) =>
      setDeviceStatus({ data: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  return (
    <>
      <PageHeader
        title="Devices"
        description="Machines enrolled through the Claude Code plugin. Gateway tokens are bound to the device fingerprint, so a copied token is useless elsewhere."
      />
      <Card>
        {data.length === 0 ? (
          <EmptyState
            title="No devices enrolled"
            description="Run /acl login in Claude Code to enroll this machine."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Device</TH>
                <TH>User</TH>
                <TH>Status</TH>
                <TH>First seen from</TH>
                <TH>Enrolled</TH>
                <TH>Last seen</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {data.map(({ device: d, userName, userEmail }) => (
                <TR key={d.id}>
                  <TD className="text-xs">
                    <div className="font-medium">{d.label}</div>
                    <div className="text-[11px] text-subtle">{d.platform}</div>
                  </TD>
                  <TD className="text-xs">
                    <div>{userName}</div>
                    <div className="text-[11px] text-subtle">{userEmail}</div>
                  </TD>
                  <TD>
                    <Badge tone={statusTone[d.status]} dot>
                      {d.status === 'pending' ? 'Awaiting approval' : d.status}
                    </Badge>
                  </TD>
                  <TD className="text-xs text-muted">
                    {d.firstSeenIp ?? '—'} {d.firstSeenCountry ? `(${d.firstSeenCountry})` : ''}
                  </TD>
                  <TD className="text-xs text-muted">{timeAgo(d.createdAt)}</TD>
                  <TD className="text-xs text-muted">
                    {d.lastSeenAt ? timeAgo(d.lastSeenAt) : '—'}
                  </TD>
                  {isAdmin ? (
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        {d.status !== 'trusted' ? (
                          <Button
                            size="sm"
                            onClick={() => mutate.mutate({ id: d.id, status: 'trusted' })}
                          >
                            Trust
                          </Button>
                        ) : null}
                        {d.status !== 'revoked' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => mutate.mutate({ id: d.id, status: 'revoked' })}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  )
}
