import {
  resourceCoversTool,
  type ToolTier,
  toolTierFromAnnotations,
  withMcpTool,
} from '@acl/shared'
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select } from '@acl/ui'
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { type PickerOption, SubjectPicker } from '#/components/subject-picker.tsx'
import {
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

export const Route = createFileRoute('/_app/access/resources_/$resourceId')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(resourcesQuery),
      queryClient.ensureQueryData(serversQuery),
      queryClient.ensureQueryData(groupsQuery),
      queryClient.ensureQueryData(membersQuery),
    ]),
  component: ResourcePage,
})

type Grant = { type: 'user' | 'group'; id: string }
type Draft = { name: string; description: string; tools: Record<string, string[]>; grants: Grant[] }
type Tool = {
  server: string
  serverName: string
  name: string
  description: string
  tier: ToolTier
}

const tierTone: Record<ToolTier, 'neutral' | 'warn' | 'bad'> = {
  read: 'neutral',
  write: 'warn',
  destructive: 'bad',
}

function ResourcePage() {
  const { resourceId } = Route.useParams()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const [resources, servers, groups, members] = useQueries({
    queries: [resourcesQuery, serversQuery, groupsQuery, membersQuery],
  })
  const isNew = resourceId === 'new'
  const existing = resources.data?.find((r) => r.id === resourceId)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [search, setSearch] = useState('')
  const [serverFilter, setServerFilter] = useState('')
  useEffect(() => {
    if (draft) return
    if (isNew) setDraft({ name: '', description: '', tools: {}, grants: [] })
    else if (existing)
      setDraft({
        name: existing.name,
        description: existing.description ?? '',
        tools: existing.tools,
        grants: existing.grants,
      })
  }, [draft, isNew, existing])

  const serverList = servers.data ?? []
  const allTools: Tool[] = useMemo(
    () =>
      serverList.flatMap((s) =>
        (s.tools as { name: string; description?: string; annotations?: unknown }[]).map((t) => ({
          server: s.id,
          serverName: s.name,
          name: t.name,
          description: t.description ?? '',
          tier: toolTierFromAnnotations(t.annotations),
        })),
      ),
    [serverList],
  )

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const { id } = await saveResource({
        data: {
          id: isNew ? undefined : resourceId,
          name: d.name,
          description: d.description || undefined,
          tools: d.tools,
        },
      })
      await setResourceGrants({ data: { resourceId: id, grants: d.grants } })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['resources'] })
      await qc.invalidateQueries({ queryKey: ['mcp-servers'] })
      await navigate({ to: '/access/resources' })
    },
  })

  if (!draft) {
    return resources.isPending || isNew ? null : (
      <p className="text-sm text-muted">
        This resource no longer exists.{' '}
        <Link to="/access/resources" className="text-accent-strong hover:underline">
          Back to resources
        </Link>
      </p>
    )
  }

  const covered = (t: Tool) => resourceCoversTool(draft.tools, t.server, t.name)
  const namesOf = (server: string) => allTools.filter((t) => t.server === server).map((t) => t.name)
  const setServer = (server: string, patterns: string[]) => {
    const { [server]: _, ...rest } = draft.tools
    setDraft({ ...draft, tools: patterns.length ? { ...rest, [server]: patterns } : rest })
  }
  const add = (t: Tool) =>
    setServer(t.server, withMcpTool(draft.tools[t.server] ?? [], t.name, true, namesOf(t.server)))
  const remove = (t: Tool) =>
    setServer(t.server, withMcpTool(draft.tools[t.server] ?? [], t.name, false, namesOf(t.server)))

  const query = search.trim().toLowerCase()
  const available = allTools.filter(
    (t) =>
      !covered(t) &&
      (!serverFilter || t.server === serverFilter) &&
      (!query || `${t.name} ${t.description} ${t.serverName}`.toLowerCase().includes(query)),
  )
  const included = allTools.filter(covered)
  const includedServers = serverList.filter(
    (s) => draft.tools[s.id] !== undefined || included.some((t) => t.server === s.id),
  )

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

  return (
    <>
      <Link
        to="/access/resources"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> Resources
      </Link>
      <PageHeader
        title={isNew ? 'New resource' : draft.name || 'Resource'}
        description="A named set of MCP tools. Whoever it is granted to can call the tools in it."
        actions={
          <>
            <Link to="/access/resources">
              <Button variant="ghost">Cancel</Button>
            </Link>
            <Button
              variant="primary"
              disabled={save.isPending || !draft.name.trim()}
              onClick={() => save.mutate(draft)}
            >
              Save
            </Button>
          </>
        }
      />
      <div className="mb-4">
        <FormError message={save.error?.message ?? null} />
      </div>

      <Card className="mb-4 grid gap-4 p-4 md:grid-cols-2">
        <Field label="Name">
          <Input
            value={draft.name}
            maxLength={120}
            placeholder="Customer data: read"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <Input
            value={draft.description}
            maxLength={500}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card className="flex min-h-0 flex-col">
          <CardHeader
            title="Available tools"
            description={`${available.length} of ${allTools.length - included.length} not in this resource. Click a tool to add it.`}
          />
          <div className="flex gap-2 border-b border-line p-3">
            <Input
              aria-label="Search tools"
              placeholder="Search by tool, description or server"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label="Server"
              className="w-44"
              value={serverFilter}
              onChange={(e) => setServerFilter(e.target.value)}
            >
              <option value="">All servers</option>
              {serverList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
            {available.map((t) => (
              <li key={`${t.server}:${t.name}`}>
                <ToolRow tool={t} action="add" onClick={() => add(t)} />
              </li>
            ))}
            {available.length === 0 ? (
              <li className="px-4 py-8 text-center text-xs text-muted">
                {allTools.length === 0
                  ? 'No MCP servers with tools yet. Connect one on the Integrations page.'
                  : query || serverFilter
                    ? 'No tool matches.'
                    : 'Every tool is already in this resource.'}
              </li>
            ) : null}
          </ul>
        </Card>

        <Card className="flex min-h-0 flex-col">
          <CardHeader
            title="In this resource"
            description={`${included.length} ${included.length === 1 ? 'tool' : 'tools'} from ${includedServers.length} ${includedServers.length === 1 ? 'server' : 'servers'}. Click a tool to take it out.`}
          />
          <div className="max-h-[32rem] overflow-y-auto">
            {draft.tools['*'] ? (
              <div className="flex items-center gap-2 border-b border-line bg-panel-2/60 px-4 py-2 text-xs">
                <span className="font-medium">Every server</span>
                {draft.tools['*'].map((p) => (
                  <Badge key={p} className="font-mono">
                    {p}
                  </Badge>
                ))}
                <button
                  type="button"
                  className="ml-auto text-muted hover:text-fg hover:underline"
                  onClick={() => setServer('*', [])}
                >
                  Remove
                </button>
              </div>
            ) : null}
            {includedServers.map((s) => {
              const whole = draft.tools[s.id]?.includes('*') ?? false
              const tools = included.filter((t) => t.server === s.id)
              return (
                <div key={s.id} className="border-b border-line last:border-b-0">
                  <div className="flex items-center gap-2 bg-panel-2/60 px-4 py-2 text-xs">
                    <span className="font-medium">{s.name}</span>
                    {whole ? <Badge tone="accent">all tools, new ones too</Badge> : null}
                    <span className="ml-auto flex gap-3">
                      {whole ? null : (
                        <button
                          type="button"
                          className="text-accent-strong hover:underline"
                          onClick={() => setServer(s.id, ['*'])}
                        >
                          Add all, and new ones
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-muted hover:text-fg hover:underline"
                        onClick={() => setServer(s.id, [])}
                      >
                        Remove all
                      </button>
                    </span>
                  </div>
                  <ul className="divide-y divide-line">
                    {tools.map((t) => (
                      <li key={t.name}>
                        <ToolRow tool={t} action="remove" onClick={() => remove(t)} />
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
            {includedServers.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted">
                No tools yet. Add some from the list on the left.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line p-3">
            {serverList
              .filter((s) => !includedServers.includes(s))
              .map((s) => (
                <Button key={s.id} size="sm" onClick={() => setServer(s.id, ['*'])}>
                  <Plus /> All of {s.name}
                </Button>
              ))}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Who can use it"
          description="People and groups this resource is granted to. Admins can always call every tool."
        />
        <div className="p-4">
          <SubjectPicker
            options={options}
            value={draft.grants}
            onChange={(grants) => setDraft({ ...draft, grants })}
          />
        </div>
      </Card>
    </>
  )
}

function ToolRow({
  tool,
  action,
  onClick,
}: {
  tool: Tool
  action: 'add' | 'remove'
  onClick: () => void
}) {
  const Icon = action === 'add' ? Plus : X
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${action === 'add' ? 'Add' : 'Remove'} ${tool.name}`}
      className="group flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-panel-2"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-xs">{tool.name}</span>
          <Badge tone={tierTone[tool.tier]}>{tool.tier}</Badge>
          {action === 'add' ? (
            <span className="text-[11px] text-subtle">{tool.serverName}</span>
          ) : null}
        </span>
        {tool.description ? (
          <span className="mt-0.5 block truncate text-[11px] text-subtle">{tool.description}</span>
        ) : null}
      </span>
      <Icon className="size-3.5 shrink-0 text-subtle group-hover:text-fg" />
    </button>
  )
}
