import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Sheet,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { McpToolPicker, toolSummary } from '#/components/mcp-tool-picker.tsx'
import { type PickerOption, SubjectPicker } from '#/components/subject-picker.tsx'
import {
  deleteResource,
  listGroups,
  listMembers,
  listResources,
  saveResource,
  setResourceGrants,
} from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'

const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const membersQuery = queryOptions({ queryKey: ['members'], queryFn: () => listMembers() })

export const Route = createFileRoute('/_app/access/resources')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(resourcesQuery),
      queryClient.ensureQueryData(serversQuery),
      queryClient.ensureQueryData(groupsQuery),
      queryClient.ensureQueryData(membersQuery),
    ]),
  component: ResourcesPage,
})

type Resource = Awaited<ReturnType<typeof listResources>>[number]
type Draft = {
  id?: string
  name: string
  description: string
  tools: Record<string, string[]>
}

function ResourcesPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [resources, servers, groups, members] = useQueries({
    queries: [resourcesQuery, serversQuery, groupsQuery, membersQuery],
  })
  const [editing, setEditing] = useState<Draft | null>(null)
  const [granting, setGranting] = useState<Resource | null>(null)
  const [grants, setGrants] = useState<{ type: 'user' | 'group'; id: string }[]>([])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['resources'] })
  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveResource({
        data: {
          id: d.id,
          name: d.name,
          description: d.description || undefined,
          tools: d.tools,
        },
      }),
    onSuccess: async () => {
      setEditing(null)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteResource({ data: { id } }),
    onSuccess: invalidate,
  })
  const saveGrants = useMutation({
    mutationFn: () => setResourceGrants({ data: { resourceId: granting!.id, grants } }),
    onSuccess: async () => {
      setGranting(null)
      await invalidate()
    },
  })

  const serverList = servers.data ?? []
  const options: PickerOption[] = [
    ...(groups.data ?? []).map((g) => ({
      type: 'group' as const,
      id: g.id,
      label: g.name,
      sub: `${g.members.length} members`,
    })),
    ...(members.data ?? []).map((m) => ({
      type: 'user' as const,
      id: m.userId,
      label: m.name,
      sub: m.email,
    })),
  ]
  const subjectLabel = (s: { type: string; id: string }) =>
    options.find((o) => o.type === s.type && o.id === s.id)?.label ?? s.id

  return (
    <>
      <PageHeader
        title="Resources"
        description="A resource is a named set of MCP tools, from one server or several. Grant it to people or groups: it is the only way to give them MCP tools. In Claude Code a session can narrow itself to some resources with /acl resources."
        actions={
          isAdmin ? (
            <Button
              variant="primary"
              disabled={serverList.length === 0}
              onClick={() =>
                setEditing({
                  name: '',
                  description: '',
                  tools: {},
                })
              }
            >
              <Plus /> New resource
            </Button>
          ) : null
        }
      />
      <Card>
        {(resources.data ?? []).length === 0 ? (
          <EmptyState
            title="No resources yet"
            description={
              serverList.length === 0 ? (
                <>
                  Connect an MCP server on the{' '}
                  <Link to="/integrations" className="text-accent-strong hover:underline">
                    Integrations
                  </Link>{' '}
                  page first.
                </>
              ) : (
                'Create one, e.g. "GitHub (read only)" with tools get_* and list_*.'
              )
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Resource</TH>
                <TH>Tools</TH>
                <TH>Granted to</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {resources.data!.map((r) => (
                <TR key={r.id}>
                  <TD className="text-xs">
                    <div className="font-medium">{r.name}</div>
                    {r.description ? (
                      <div className="max-w-72 truncate text-[11px] text-subtle">
                        {r.description}
                      </div>
                    ) : null}
                    <div className="font-mono text-[11px] text-subtle">{r.id}</div>
                  </TD>
                  <TD>
                    <div className="flex max-w-96 flex-wrap gap-1">
                      {Object.keys(r.tools).length === 0 ? (
                        <span className="text-xs text-subtle">No tools yet</span>
                      ) : (
                        toolSummary(r.tools, serverList).map((line) => (
                          <Badge key={line}>{line}</Badge>
                        ))
                      )}
                    </div>
                  </TD>
                  <TD>
                    <div className="flex max-w-80 flex-wrap gap-1">
                      {r.grants.length === 0 ? (
                        <span className="text-xs text-subtle">Admins only</span>
                      ) : null}
                      {r.grants.map((g) => (
                        <Badge
                          key={`${g.type}:${g.id}`}
                          tone={g.type === 'group' ? 'info' : 'neutral'}
                        >
                          {subjectLabel(g)}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  {isAdmin ? (
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          onClick={() => {
                            setGrants(r.grants)
                            setGranting(r)
                          }}
                        >
                          Access
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setEditing({
                              id: r.id,
                              name: r.name,
                              description: r.description ?? '',
                              tools: r.tools,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => confirm(`Delete ${r.name}?`) && remove.mutate(r.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Sheet
        wide
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? 'Edit resource' : 'New resource'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !editing?.name}
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
            <McpToolPicker
              servers={serverList}
              value={editing.tools}
              onChange={(tools) => setEditing({ ...editing, tools })}
            />
            <FormError message={save.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={granting !== null}
        onOpenChange={(o) => !o && setGranting(null)}
        title={`Who can use ${granting?.name ?? ''}`}
        description="Org admins can always use every resource."
        footer={
          <>
            <Button variant="ghost" onClick={() => setGranting(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={saveGrants.isPending}
              onClick={() => saveGrants.mutate()}
            >
              Save access
            </Button>
          </>
        }
      >
        <SubjectPicker options={options} value={grants} onChange={setGrants} />
        <div className="mt-3">
          <FormError message={saveGrants.error?.message ?? null} />
        </div>
      </Sheet>
    </>
  )
}
