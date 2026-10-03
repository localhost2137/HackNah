import { Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Sheet } from '@acl/ui'
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { SubjectPicker } from '#/components/subject-picker.tsx'
import {
  deleteGroup,
  listGroups,
  listMembers,
  saveGroup,
  setGroupMembers,
} from '#/server/fns/access.ts'

const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const membersQuery = queryOptions({ queryKey: ['members'], queryFn: () => listMembers() })

export const Route = createFileRoute('/_app/access/groups')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(groupsQuery),
      queryClient.ensureQueryData(membersQuery),
    ]),
  component: GroupsPage,
})

type Group = Awaited<ReturnType<typeof listGroups>>[number]

function GroupsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [groups, members] = useQueries({ queries: [groupsQuery, membersQuery] })
  const [editing, setEditing] = useState<{ id?: string; name: string; description: string } | null>(
    null,
  )
  const [membersOf, setMembersOf] = useState<Group | null>(null)
  const [selection, setSelection] = useState<{ type: 'user' | 'group'; id: string }[]>([])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['groups'] })
  const save = useMutation({
    mutationFn: (g: { id?: string; name: string; description: string }) =>
      saveGroup({ data: { id: g.id, name: g.name, description: g.description || undefined } }),
    onSuccess: async () => {
      setEditing(null)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup({ data: { id } }),
    onSuccess: invalidate,
  })
  const saveMembers = useMutation({
    mutationFn: () =>
      setGroupMembers({ data: { groupId: membersOf!.id, userIds: selection.map((s) => s.id) } }),
    onSuccess: async () => {
      setMembersOf(null)
      await qc.invalidateQueries({ queryKey: ['groups'] })
      await qc.invalidateQueries({ queryKey: ['members'] })
    },
  })

  return (
    <>
      <PageHeader
        title="Groups"
        description="Grant resources to teams instead of individuals."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setEditing({ name: '', description: '' })}>
              <Plus /> New group
            </Button>
          ) : null
        }
      />
      {(groups.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            title="No groups"
            description="Create groups like Backend, Data or Contractors."
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.data!.map((g) => (
            <Card key={g.id}>
              <CardHeader
                title={g.name}
                description={g.description ?? `${g.members.length} members`}
                actions={
                  isAdmin ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelection(g.members.map((m) => ({ type: 'user', id: m.userId })))
                          setMembersOf(g)
                        }}
                      >
                        Members
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditing({ id: g.id, name: g.name, description: g.description ?? '' })
                        }
                      >
                        Edit
                      </Button>
                    </>
                  ) : null
                }
              />
              <ul className="divide-y divide-line">
                {g.members.slice(0, 6).map((m) => (
                  <li key={m.userId} className="flex justify-between px-4 py-2 text-xs">
                    <span>{m.name}</span>
                    <span className="text-subtle">{m.email}</span>
                  </li>
                ))}
                {g.members.length > 6 ? (
                  <li className="px-4 py-2 text-xs text-muted">+{g.members.length - 6} more</li>
                ) : null}
                {g.members.length === 0 ? (
                  <li className="px-4 py-3 text-xs text-muted">No members</li>
                ) : null}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <Sheet
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? 'Edit group' : 'New group'}
        footer={
          <>
            {editing?.id ? (
              <Button
                variant="danger"
                className="mr-auto"
                onClick={() => {
                  if (editing.id && confirm('Delete this group? Its grants are removed too.')) {
                    remove.mutate(editing.id)
                    setEditing(null)
                  }
                }}
              >
                Delete
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!editing?.name || save.isPending}
              onClick={() => editing && save.mutate(editing)}
            >
              Save
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <Input
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </Field>
            <FormError message={save.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={membersOf !== null}
        onOpenChange={(o) => !o && setMembersOf(null)}
        title={`Members of ${membersOf?.name ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMembersOf(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={saveMembers.isPending}
              onClick={() => saveMembers.mutate()}
            >
              Save members
            </Button>
          </>
        }
      >
        <SubjectPicker
          options={(members.data ?? []).map((m) => ({
            type: 'user',
            id: m.userId,
            label: m.name,
            sub: m.email,
          }))}
          value={selection}
          onChange={setSelection}
        />
        <div className="mt-3">
          <FormError message={saveMembers.error?.message ?? null} />
        </div>
      </Sheet>
    </>
  )
}
