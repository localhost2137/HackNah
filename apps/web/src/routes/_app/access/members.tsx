import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { UserPlus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { timeAgo } from '#/lib/format.ts'
import { addMember, listMembers, removeMember, updateMemberRole } from '#/server/fns/access.ts'

const membersQuery = queryOptions({ queryKey: ['members'], queryFn: () => listMembers() })

export const Route = createFileRoute('/_app/access/members')({
  loader: ({ context }) => context.queryClient.ensureQueryData(membersQuery),
  component: MembersPage,
})

function MembersPage() {
  const { isAdmin, viewer } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data = [] } = useQuery(membersQuery)
  const [adding, setAdding] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['members'] })
  const add = useMutation({
    mutationFn: () => addMember({ data: { email, role } }),
    onSuccess: async () => {
      setAdding(false)
      setEmail('')
      await invalidate()
    },
  })
  const changeRole = useMutation({
    mutationFn: (args: { memberId: string; role: 'member' | 'admin' }) =>
      updateMemberRole({ data: args }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (memberId: string) => removeMember({ data: { memberId } }),
    onSuccess: invalidate,
  })

  return (
    <>
      <PageHeader
        title="Members"
        description="People in this organization. Admins manage policy and decide approvals; members only get the resources granted to them."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <UserPlus /> Add member
            </Button>
          ) : null
        }
      />
      <Card>
        <Table>
          <THead>
            <tr>
              <TH>Member</TH>
              <TH>Role</TH>
              <TH>Groups</TH>
              <TH>Trusted devices</TH>
              <TH>Joined</TH>
              {isAdmin ? <TH /> : null}
            </tr>
          </THead>
          <TBody>
            {data.map((m) => (
              <TR key={m.memberId}>
                <TD className="text-xs">
                  <div className="font-medium">
                    {m.name}{' '}
                    {m.userId === viewer.user.id ? (
                      <span className="text-subtle">(you)</span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-subtle">{m.email}</div>
                </TD>
                <TD>
                  {isAdmin && m.userId !== viewer.user.id ? (
                    <Select
                      className="h-7 w-28"
                      value={m.role}
                      onChange={(e) =>
                        changeRole.mutate({
                          memberId: m.memberId,
                          role: e.target.value as 'member' | 'admin',
                        })
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </Select>
                  ) : (
                    <Badge tone={m.role === 'member' ? 'neutral' : 'accent'}>{m.role}</Badge>
                  )}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {m.groups.map((g) => (
                      <Badge key={g.id} tone="info">
                        {g.name}
                      </Badge>
                    ))}
                    {m.groups.length === 0 ? <span className="text-xs text-subtle">—</span> : null}
                  </div>
                </TD>
                <TD className="text-xs">
                  <Link
                    to="/events"
                    search={{ user: m.userId, range: '30d' }}
                    className="hover:text-accent-strong"
                  >
                    View logs
                  </Link>
                </TD>
                <TD className="text-xs text-muted">{timeAgo(m.joinedAt)}</TD>
                {isAdmin ? (
                  <TD className="text-right">
                    {m.userId !== viewer.user.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => confirm(`Remove ${m.name}?`) && remove.mutate(m.memberId)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <FormError message={changeRole.error?.message ?? remove.error?.message ?? null} />

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add member"
        description="The person needs an account first (they can sign up on the login page)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!email || add.isPending}
              onClick={() => add.mutate()}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <FormError message={add.error?.message ?? null} />
        </div>
      </Dialog>
    </>
  )
}
