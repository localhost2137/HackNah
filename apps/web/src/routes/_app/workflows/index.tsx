import { kindLabels, type PolicyGraph } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Sheet,
  Switch,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Plus, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { CheckboxGroup } from '#/components/workflow/step-form.tsx'
import { listGroups, listResources } from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  reorderWorkflows,
  updateWorkflow,
} from '#/server/fns/workflow.ts'

const workflowsQuery = queryOptions({ queryKey: ['workflows'], queryFn: () => listWorkflows() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })

export const Route = createFileRoute('/_app/workflows/')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(workflowsQuery),
      queryClient.ensureQueryData(groupsQuery),
    ]),
  component: WorkflowsPage,
})

type Workflow = Awaited<ReturnType<typeof listWorkflows>>[number]
type Settings = { workflowId: string; name: string; description: string; groupIds: string[] }

/** The stages a workflow runs on; what it asks after that lives in its condition blocks. */
function triggerText(graph: PolicyGraph): string {
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  const stages = trigger?.type === 'trigger' ? trigger.stages : []
  if (stages.length === 0) return 'Any stage'
  return stages.map((k) => kindLabels[k]).join(', ')
}

function WorkflowsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [workflows, groups, servers, resources] = useQueries({
    queries: [workflowsQuery, groupsQuery, serversQuery, resourcesQuery],
  })
  const [creating, setCreating] = useState<{ name: string; copyOf: string } | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const list = workflows.data ?? []
  const groupList = groups.data ?? []
  const names: Record<string, string> = {
    ...Object.fromEntries(groupList.map((g) => [g.id, g.name])),
    ...Object.fromEntries((servers.data ?? []).map((s) => [s.id, s.name])),
    ...Object.fromEntries((resources.data ?? []).map((r) => [r.id, r.name])),
  }
  const everyoneId = groupList.find((g) => g.isDefault)?.id

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workflows'] })
  const create = useMutation({
    mutationFn: (d: { name: string; copyOf: string }) =>
      createWorkflow({ data: { name: d.name, copyOf: d.copyOf || undefined } }),
    onSuccess: async ({ id }) => {
      setCreating(null)
      await invalidate()
      await navigate({ to: '/workflows/$workflowId', params: { workflowId: id } })
    },
  })
  const update = useMutation({
    mutationFn: (d: Parameters<typeof updateWorkflow>[0]['data']) => updateWorkflow({ data: d }),
    onSuccess: async () => {
      setSettings(null)
      await invalidate()
    },
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderWorkflows({ data: { ids } }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (workflowId: string) => deleteWorkflow({ data: { workflowId } }),
    onSuccess: async () => {
      setSettings(null)
      await invalidate()
    },
  })

  const move = (index: number, by: -1 | 1) => {
    const ids = list.map((w) => w.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id!)
    reorder.mutate(ids)
  }

  const runsForEveryone = (w: Workflow) =>
    w.groupIds.length === 0 || (everyoneId != null && w.groupIds.includes(everyoneId))
  const catchAll = list.some((w) => {
    const trigger = w.published?.definition.nodes.find((n) => n.type === 'trigger')
    return (
      w.enabled && trigger?.type === 'trigger' && trigger.stages.length === 0 && runsForEveryone(w)
    )
  })

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Every enabled workflow that runs on the request's stage, and whose groups include the user, runs. The strictest outcome wins: block, then approval, then allow; a workflow that ends in Skip does not count."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setCreating({ name: '', copyOf: '' })}>
              <Plus /> New workflow
            </Button>
          ) : null
        }
      />
      {!catchAll && list.length > 0 ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            No live workflow covers every request for every member. A request that starts no
            workflow is allowed without any checks, including the device fingerprint.
          </span>
        </div>
      ) : null}
      <Card>
        {list.length === 0 ? (
          <EmptyState
            title="No workflows"
            description="Without a workflow every request is allowed. Create one to check tool calls or prompts."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                {isAdmin ? <TH className="w-16" /> : null}
                <TH>Workflow</TH>
                <TH>Runs on</TH>
                <TH>Runs for</TH>
                <TH>Version</TH>
                <TH>Enabled</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {list.map((w, i) => (
                <TR key={w.id}>
                  {isAdmin ? (
                    <TD>
                      <div className="flex">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Move up"
                          disabled={i === 0 || reorder.isPending}
                          onClick={() => move(i, -1)}
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Move down"
                          disabled={i === list.length - 1 || reorder.isPending}
                          onClick={() => move(i, 1)}
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                      </div>
                    </TD>
                  ) : null}
                  <TD>
                    <Link
                      to="/workflows/$workflowId"
                      params={{ workflowId: w.id }}
                      className="text-sm font-medium hover:text-accent-strong"
                    >
                      {w.name}
                    </Link>
                    {w.description ? (
                      <div className="text-xs text-muted">{w.description}</div>
                    ) : null}
                  </TD>
                  <TD className="max-w-72 text-xs text-muted">{triggerText(w.definition)}</TD>
                  <TD>
                    {runsForEveryone(w) ? (
                      <span className="text-xs text-muted">Everyone</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {w.groupIds.map((id) => (
                          <Badge key={id}>{names[id] ?? id}</Badge>
                        ))}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <div className="flex gap-1">
                      {w.published ? (
                        <Badge tone="ok">live v{w.published.version}</Badge>
                      ) : (
                        <Badge tone="neutral">not published</Badge>
                      )}
                      {w.draftVersion ? <Badge tone="warn">draft</Badge> : null}
                    </div>
                  </TD>
                  <TD>
                    <Switch
                      checked={w.enabled}
                      disabled={!isAdmin}
                      onCheckedChange={(enabled) => update.mutate({ workflowId: w.id, enabled })}
                      label="Enabled"
                    />
                  </TD>
                  {isAdmin ? (
                    <TD className="text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSettings({
                            workflowId: w.id,
                            name: w.name,
                            description: w.description ?? '',
                            groupIds: w.groupIds,
                          })
                        }
                      >
                        Settings
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCreating({ name: `${w.name} (copy)`, copyOf: w.id })}
                      >
                        Duplicate
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        title="New workflow"
        description="It starts as a draft and doesn't run until you publish it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || !creating?.name.trim()}
              onClick={() => creating && create.mutate(creating)}
            >
              Create
            </Button>
          </>
        }
      >
        {creating ? (
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                autoFocus
                value={creating.name}
                maxLength={80}
                placeholder="GitHub destructive tools"
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </Field>
            <Field label="Start from">
              <Select
                value={creating.copyOf}
                onChange={(e) => setCreating({ ...creating, copyOf: e.target.value })}
              >
                <option value="">Blank: tool calls are allowed</option>
                {list.map((w) => (
                  <option key={w.id} value={w.id}>
                    Copy of {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <FormError message={create.error?.message ?? null} />
          </div>
        ) : null}
      </Dialog>

      <Sheet
        open={settings !== null}
        onOpenChange={(o) => !o && setSettings(null)}
        title="Workflow settings"
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto text-bad"
              disabled={remove.isPending}
              onClick={() =>
                settings &&
                window.confirm(`Delete "${settings.name}" and all its versions?`) &&
                remove.mutate(settings.workflowId)
              }
            >
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setSettings(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={update.isPending || !settings?.name.trim()}
              onClick={() =>
                settings &&
                update.mutate({
                  ...settings,
                  description: settings.description.trim() || null,
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        {settings ? (
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                value={settings.name}
                maxLength={80}
                onChange={(e) => setSettings({ ...settings, name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <Textarea
                rows={2}
                value={settings.description}
                maxLength={500}
                onChange={(e) => setSettings({ ...settings, description: e.target.value })}
              />
            </Field>
            <Field
              label="Runs for"
              hint="Leave every group unticked to run for all members. Which requests start it is set on the first step of the workflow."
            >
              {groupList.length === 0 ? (
                <p className="text-xs text-subtle">No groups defined yet.</p>
              ) : (
                <CheckboxGroup
                  options={groupList.map((g) => ({ value: g.id, label: g.name }))}
                  value={settings.groupIds}
                  onChange={(groupIds) => setSettings({ ...settings, groupIds })}
                />
              )}
            </Field>
            <FormError message={update.error?.message ?? remove.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
