import { kindLabels } from '@acl/shared'
import { Badge, Button, Card, EmptyState, Table, TBody, TD, TH, THead, TR } from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, MonitorSmartphone, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { kindIcons } from '#/components/event-bits.tsx'
import { Segmented } from '#/components/filters.tsx'
import { timeAgo } from '#/lib/format.ts'
import { useLive } from '#/lib/live.tsx'
import { decideApproval, listApprovals } from '#/server/fns/approvals.ts'

const approvalsQuery = (status: 'pending' | 'history') =>
  queryOptions({
    queryKey: ['approvals', status],
    queryFn: () => listApprovals({ data: { status } }),
  })

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function ApprovalRecords() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending')
  const isAdmin = true
  const navigate = useNavigate()
  const qc = useQueryClient()
  const live = useLive()
  const { data = [] } = useQuery(approvalsQuery(tab))

  // The live stream tells us when the queue changes; the list itself comes from D1.
  const liveKey = live.pendingApprovals.map((a) => a.id).join(',')
  useEffect(() => {
    void liveKey
    qc.invalidateQueries({ queryKey: ['approvals'] })
  }, [liveKey, qc])

  const decide = useMutation({
    mutationFn: (args: { id: string; status: 'approved' | 'declined' }) =>
      decideApproval({ data: args }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  })

  return (
    <>
      <div className="mb-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>
      {tab === 'pending' ? (
        data.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing waiting"
              description="New requests that need a decision will show up here instantly."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {data.map((row) => (
              <PendingCard
                key={row.approval.id}
                row={row}
                canDecide={isAdmin}
                busy={decide.isPending && decide.variables?.id === row.approval.id}
                onDecide={(status) => decide.mutate({ id: row.approval.id, status })}
              />
            ))}
            {decide.error ? <div className="text-xs text-bad">{decide.error.message}</div> : null}
          </div>
        )
      ) : (
        <Card>
          {data.length === 0 ? (
            <EmptyState title="No decisions yet" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Request</TH>
                  <TH>User</TH>
                  <TH>Reason</TH>
                  <TH>Outcome</TH>
                  <TH>Decided by</TH>
                  <TH>When</TH>
                </tr>
              </THead>
              <TBody>
                {data.map(({ approval: a, userName, decidedByName }) => (
                  <TR
                    key={a.id}
                    onClick={() =>
                      navigate({ to: '/events', search: { selected: a.eventId, range: '30d' } })
                    }
                  >
                    <TD className="max-w-80 truncate text-xs">{a.summary}</TD>
                    <TD className="text-xs">{userName}</TD>
                    <TD className="max-w-60 truncate text-xs text-muted">{a.reasons.join('; ')}</TD>
                    <TD>
                      <Badge
                        tone={
                          a.status === 'approved'
                            ? 'ok'
                            : a.status === 'declined'
                              ? 'bad'
                              : 'neutral'
                        }
                        dot
                      >
                        {a.status}
                      </Badge>
                    </TD>
                    <TD className="text-xs text-muted">
                      {decidedByName ?? (a.status === 'expired' ? 'timed out' : '—')}
                    </TD>
                    <TD className="text-xs text-muted">{timeAgo(a.decidedAt ?? a.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  )
}

type Row = Awaited<ReturnType<typeof listApprovals>>[number]

function PendingCard({
  row,
  canDecide,
  busy,
  onDecide,
}: {
  row: Row
  canDecide: boolean
  busy: boolean
  onDecide: (status: 'approved' | 'declined') => void
}) {
  const now = useNow()
  const a = row.approval
  const left = Math.max(0, Math.round((new Date(a.expiresAt).getTime() - now) / 1000))
  const Icon = a.trustsDevice ? MonitorSmartphone : kindIcons[a.kind]

  return (
    <Card className="flex items-start gap-4 border-warn/30 px-4 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-warn-soft text-warn">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">
            {a.trustsDevice ? 'New device sign-in' : kindLabels[a.kind]}
          </span>
          {a.reasons.map((r) => (
            <Badge key={r} tone="warn">
              {r}
            </Badge>
          ))}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-muted">{a.summary}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
          <span>
            {row.userName} ({row.userEmail})
          </span>
          {row.deviceLabel ? (
            <span>
              {row.deviceLabel}
              {row.deviceIp ? ` · ${row.deviceIp}` : ''}
              {row.deviceCountry ? ` (${row.deviceCountry})` : ''}
            </span>
          ) : null}
          <span>{timeAgo(a.createdAt)}</span>
          <Link
            to="/events"
            search={{ selected: a.eventId, range: '24h' }}
            className="text-accent-strong hover:underline"
          >
            Event
          </Link>
        </div>
        {a.trustsDevice ? (
          <div className="mt-2 text-[11px] text-muted">
            Approving also marks this device as trusted for future requests.
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className={left < 30 ? 'font-mono text-xs text-bad' : 'font-mono text-xs text-muted'}>
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </span>
        {canDecide ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('declined')}>
              <X /> Decline
            </Button>
            <Button
              size="sm"
              variant="success"
              disabled={busy}
              onClick={() => onDecide('approved')}
            >
              <Check /> Approve
            </Button>
          </div>
        ) : (
          <span className="text-[11px] text-subtle">Admins decide</span>
        )}
      </div>
    </Card>
  )
}
