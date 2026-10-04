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
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { FormError } from '#/components/auth-shell.tsx'
import { toolSummary } from '#/lib/resource-tools.ts'
import { deleteResource, listGroups, listMembers, listResources } from '#/server/fns/access.ts'
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

function ResourcesPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [resources, servers, groups, members] = useQueries({
    queries: [resourcesQuery, serversQuery, groupsQuery, membersQuery],
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteResource({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resources'] }),
  })

  const serverList = servers.data ?? []
  const subjectLabel = (s: { type: string; id: string }) =>
    s.type === 'group'
      ? (groups.data?.find((g) => g.id === s.id)?.name ?? s.id)
      : (members.data?.find((m) => m.userId === s.id)?.name ?? s.id)

  return (
    <>
      <PageHeader
        title="Resources"
        description="A resource is a named set of MCP tools, from one server or several. Grant it to people or groups: it is the only way to give them MCP tools. In Claude Code a session can narrow itself to some resources with /acl resources."
        actions={
          isAdmin ? (
            <Link to="/access/resources/$resourceId" params={{ resourceId: 'new' }}>
              <Button variant="primary">
                <Plus /> New resource
              </Button>
            </Link>
          ) : null
        }
      />
      <div className="mb-3">
        <FormError message={remove.error?.message ?? null} />
      </div>
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
                'Create one, e.g. "Tickets: read" with the read tools of Jira and GitHub.'
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
                    <Link
                      to="/access/resources/$resourceId"
                      params={{ resourceId: r.id }}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.description ? (
                      <div className="max-w-72 truncate text-[11px] text-subtle">
                        {r.description}
                      </div>
                    ) : null}
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
                        <Link to="/access/resources/$resourceId" params={{ resourceId: r.id }}>
                          <Button size="sm">Edit</Button>
                        </Link>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
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
    </>
  )
}
