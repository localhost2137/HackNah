import { BUILTIN_TOOLS } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Sheet,
  Textarea,
} from '@acl/ui'
import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { SubjectPicker } from '#/components/subject-picker.tsx'
import {
  deleteGroup,
  listGroups,
  listMembers,
  listResources,
  saveGroup,
  setGroupMembers,
  setGroupPermissions,
  setGroupResources,
} from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { listModels } from '#/server/fns/models.ts'

const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const membersQuery = queryOptions({ queryKey: ['members'], queryFn: () => listMembers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const modelsQuery = queryOptions({ queryKey: ['models'], queryFn: () => listModels() })

export const Route = createFileRoute('/_app/access/groups')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(groupsQuery),
      queryClient.ensureQueryData(membersQuery),
      queryClient.ensureQueryData(resourcesQuery),
      queryClient.ensureQueryData(serversQuery),
      queryClient.ensureQueryData(modelsQuery),
    ]),
  component: GroupsPage,
})

type Group = Awaited<ReturnType<typeof listGroups>>[number]
type Server = Awaited<ReturnType<typeof listMcpServers>>[number]
type GroupDraft = {
  id?: string
  name: string
  description: string
  isDefault: boolean
  members: { type: 'user' | 'group'; id: string }[]
}
type PermissionsDraft = {
  group: Group
  resourceIds: string[]
  models: string
  builtinTools: string
  mcp: Record<string, string[]>
}

const splitPatterns = (s: string) =>
  s
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)

function GroupsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [groups, members, resources, servers] = useQueries({
    queries: [groupsQuery, membersQuery, resourcesQuery, serversQuery],
  })
  const [editing, setEditing] = useState<GroupDraft | null>(null)
  const [permissions, setPermissions] = useState<PermissionsDraft | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['groups'] })
  const save = useMutation({
    mutationFn: async (g: GroupDraft) => {
      const { id } = await saveGroup({
        data: { id: g.id, name: g.name, description: g.description || undefined },
      })
      if (!g.isDefault)
        await setGroupMembers({ data: { groupId: id, userIds: g.members.map((m) => m.id) } })
    },
    onSuccess: async () => {
      setEditing(null)
      await invalidate()
      await qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup({ data: { id } }),
    onSuccess: invalidate,
  })
  const savePermissions = useMutation({
    mutationFn: async (d: PermissionsDraft) => {
      await setGroupPermissions({
        data: {
          groupId: d.group.id,
          permissions: {
            models: splitPatterns(d.models),
            builtinTools: splitPatterns(d.builtinTools),
            // A server with no tools picked is the same as an unchecked one.
            mcp: Object.fromEntries(Object.entries(d.mcp).filter(([, tools]) => tools.length)),
          },
        },
      })
      await setGroupResources({ data: { groupId: d.group.id, resourceIds: d.resourceIds } })
    },
    onSuccess: async () => {
      setPermissions(null)
      await qc.invalidateQueries({ queryKey: ['groups'] })
      await qc.invalidateQueries({ queryKey: ['resources'] })
    },
  })

  const resourceName = (id: string) => resources.data?.find((r) => r.id === id)?.name ?? id
  const mcpSummary = (mcp: Record<string, string[]>) =>
    Object.entries(mcp).map(([id, tools]) => {
      const server =
        id === '*' ? 'Every server' : (servers.data?.find((s) => s.id === id)?.name ?? id)
      return tools.includes('*') ? server : `${server}: ${tools.join(', ')}`
    })

  return (
    <>
      <PageHeader
        title="Groups"
        description="Groups decide what their members may use: MCP servers and tools, models and Claude Code's built-in tools. Everyone is in the default group; permissions from all of a member's groups add up."
        actions={
          isAdmin ? (
            <Button
              variant="primary"
              onClick={() =>
                setEditing({ name: '', description: '', isDefault: false, members: [] })
              }
            >
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
                title={
                  <span className="flex items-center gap-2">
                    {g.name}
                    {g.isDefault ? <Badge tone="accent">default</Badge> : null}
                  </span>
                }
                description={
                  g.description ?? (g.isDefault ? 'All members' : `${g.members.length} members`)
                }
                actions={
                  isAdmin ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          setPermissions({
                            group: g,
                            resourceIds: g.resourceIds,
                            models: g.permissions.models.join('\n'),
                            builtinTools: g.permissions.builtinTools.join('\n'),
                            mcp: g.permissions.mcp,
                          })
                        }
                      >
                        Permissions
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditing({
                            id: g.id,
                            name: g.name,
                            description: g.description ?? '',
                            isDefault: g.isDefault,
                            members: g.members.map((m) => ({ type: 'user', id: m.userId })),
                          })
                        }
                      >
                        Edit
                      </Button>
                    </>
                  ) : null
                }
              />
              <div className="flex flex-col gap-1.5 px-4 py-3 text-xs">
                <PermissionRow label="MCP" values={mcpSummary(g.permissions.mcp)} empty="none" />
                <PermissionRow
                  label="Resources"
                  values={g.resourceIds.map(resourceName)}
                  empty="none"
                />
                <PermissionRow label="Models" values={g.permissions.models} empty="none" mono />
                <PermissionRow
                  label="Built-in tools"
                  values={g.permissions.builtinTools}
                  empty="none"
                  mono
                />
              </div>
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
            {editing?.id && !editing.isDefault ? (
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
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                Members{editing.isDefault ? '' : ` (${editing.members.length})`}
              </span>
              {editing.isDefault ? (
                <p className="text-xs text-subtle">
                  Every member of the instance belongs to the default group.
                </p>
              ) : (
                <SubjectPicker
                  options={(members.data ?? []).map((m) => ({
                    type: 'user',
                    id: m.userId,
                    label: m.name,
                    sub: m.email,
                  }))}
                  value={editing.members}
                  onChange={(value) => setEditing({ ...editing, members: value })}
                />
              )}
            </div>
            <FormError message={save.error?.message ?? remove.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={permissions !== null}
        onOpenChange={(o) => !o && setPermissions(null)}
        title={`What ${permissions?.group.name ?? ''} can use`}
        description="Admins can always use everything. Members get the union of all their groups."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPermissions(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={savePermissions.isPending}
              onClick={() => permissions && savePermissions.mutate(permissions)}
            >
              Save permissions
            </Button>
          </>
        }
      >
        {permissions ? (
          <div className="flex flex-col gap-5">
            <McpPermissions
              servers={servers.data ?? []}
              value={permissions.mcp}
              onChange={(mcp) => setPermissions({ ...permissions, mcp })}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Resources</span>
              <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-md border border-line">
                {(resources.data ?? []).map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-panel-2">
                      <input
                        type="checkbox"
                        checked={permissions.resourceIds.includes(r.id)}
                        onChange={(e) =>
                          setPermissions({
                            ...permissions,
                            resourceIds: e.target.checked
                              ? [...permissions.resourceIds, r.id]
                              : permissions.resourceIds.filter((id) => id !== r.id),
                          })
                        }
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="flex-1 text-xs">{r.name}</span>
                      <span className="text-[11px] text-subtle">{r.serverName}</span>
                    </label>
                  </li>
                ))}
                {(resources.data ?? []).length === 0 ? (
                  <li className="px-3 py-3 text-xs text-muted">No resources yet</li>
                ) : null}
              </ul>
              <span className="text-[11px] text-subtle">
                Named sets of MCP tools from the Resources page; they add to the servers above.
              </span>
            </div>
            <Field
              label="Models"
              hint="Model id patterns, one per line, * as wildcard. Use * for every model."
            >
              <Textarea
                rows={4}
                value={permissions.models}
                onChange={(e) => setPermissions({ ...permissions, models: e.target.value })}
                placeholder={'claude-sonnet-*\nclaude-haiku-*'}
              />
            </Field>
            <ModelChips
              value={permissions.models}
              onChange={(models) => setPermissions({ ...permissions, models })}
            />
            <Field
              label="Built-in tools"
              hint="Claude Code tool name patterns, one per line. Use * for every built-in tool."
            >
              <Textarea
                rows={4}
                value={permissions.builtinTools}
                onChange={(e) => setPermissions({ ...permissions, builtinTools: e.target.value })}
                placeholder={'Read\nGrep\nGlob'}
              />
            </Field>
            <div className="-mt-3 flex flex-wrap gap-1">
              {['*', ...BUILTIN_TOOLS].map((tool) => {
                const current = splitPatterns(permissions.builtinTools)
                const on = current.includes(tool)
                return (
                  <button
                    key={tool}
                    type="button"
                    onClick={() =>
                      setPermissions({
                        ...permissions,
                        builtinTools: (on
                          ? current.filter((t) => t !== tool)
                          : [...current, tool]
                        ).join('\n'),
                      })
                    }
                  >
                    <Badge tone={on ? 'accent' : 'neutral'} className="font-mono">
                      {tool}
                    </Badge>
                  </button>
                )
              })}
            </div>
            <FormError message={savePermissions.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>
    </>
  )
}

function PermissionRow({
  label,
  values,
  empty,
  mono,
}: {
  label: string
  values: string[]
  empty: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <div className="flex flex-wrap gap-1">
        {values.length === 0 ? <span className="text-subtle">{empty}</span> : null}
        {values.map((v) => (
          <Badge key={v} className={mono ? 'font-mono' : undefined}>
            {v === '*' ? 'all' : v}
          </Badge>
        ))}
      </div>
    </div>
  )
}

/**
 * Which MCP servers the group sees and which of their tools it may call. A server that is not
 * checked is hidden from the group's tool list entirely.
 */
function McpPermissions({
  servers,
  value,
  onChange,
}: {
  servers: Server[]
  value: Record<string, string[]>
  onChange: (value: Record<string, string[]>) => void
}) {
  const set = (id: string, tools: string[] | null) => {
    const { [id]: _, ...rest } = value
    onChange(tools ? { ...rest, [id]: tools } : rest)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">MCP servers</span>
      <ul className="divide-y divide-line rounded-md border border-line">
        {servers.map((s) => {
          const tools = value[s.id]
          const visible = tools !== undefined
          const all = tools?.includes('*') ?? false
          // Patterns that do not name a known tool (e.g. `get_*`) are kept and shown as is.
          const names = [
            ...s.tools.map((t) => t.name),
            ...(tools ?? []).filter((t) => t !== '*' && !s.tools.some((x) => x.name === t)),
          ]
          return (
            <li key={s.id} className="flex flex-col gap-2 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => set(s.id, e.target.checked ? ['*'] : null)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="flex-1 text-xs">{s.name}</span>
                {!s.enabled ? <Badge>disabled</Badge> : null}
                {visible ? (
                  <button
                    type="button"
                    className="text-[11px] text-accent-strong hover:underline"
                    onClick={() => set(s.id, all ? [] : ['*'])}
                  >
                    {all ? 'Pick tools' : 'All tools'}
                  </button>
                ) : null}
              </label>
              {visible && !all ? (
                names.length === 0 ? (
                  <p className="pl-7 text-[11px] text-subtle">
                    Tool list not loaded yet. Refresh tools on the Integrations page.
                  </p>
                ) : (
                  <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto pl-7">
                    {names.map((name) => {
                      const on = tools.includes(name)
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() =>
                            set(s.id, on ? tools.filter((t) => t !== name) : [...tools, name])
                          }
                        >
                          <Badge tone={on ? 'accent' : 'neutral'} className="font-mono">
                            {name}
                          </Badge>
                        </button>
                      )
                    })}
                  </div>
                )
              ) : null}
            </li>
          )
        })}
        {servers.length === 0 ? (
          <li className="px-3 py-3 text-xs text-muted">No MCP servers connected</li>
        ) : null}
      </ul>
      <span className="text-[11px] text-subtle">
        Unchecked servers are hidden from the group. Pick tools to allow only some of a server's
        tools.
      </span>
    </div>
  )
}

/** Models from the catalog, toggled on and off like built-in tools. */
function ModelChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: models = [] } = useQuery(modelsQuery)
  if (models.length === 0) return null
  const current = splitPatterns(value)
  return (
    <div className="-mt-3 flex flex-wrap gap-1">
      {[{ pattern: '*', label: 'Every model' }, ...models].map((m) => {
        const on = current.includes(m.pattern)
        return (
          <button
            key={m.pattern}
            type="button"
            title={m.pattern}
            onClick={() =>
              onChange(
                (on ? current.filter((p) => p !== m.pattern) : [...current, m.pattern]).join('\n'),
              )
            }
          >
            <Badge tone={on ? 'accent' : 'neutral'}>{m.label || m.pattern}</Badge>
          </button>
        )
      })}
    </div>
  )
}
