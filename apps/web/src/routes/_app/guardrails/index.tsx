import { eventKind, kindLabels, type PolicyGraph } from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
import { CheckboxGroup } from '#/components/guardrail/step-form.tsx'
import { listGroups, listResources } from '#/server/fns/access.ts'
import {
  createGuardrail,
  deleteGuardrail,
  listGuardrails,
  reorderGuardrails,
  updateGuardrail,
} from '#/server/fns/guardrail.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'

const guardrailsQuery = queryOptions({ queryKey: ['guardrails'], queryFn: () => listGuardrails() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })

export const Route = createFileRoute('/_app/guardrails/')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(guardrailsQuery),
      queryClient.ensureQueryData(groupsQuery),
    ]),
  component: GuardrailsPage,
})

type Guardrail = Awaited<ReturnType<typeof listGuardrails>>[number]
type Settings = { guardrailId: string; name: string; description: string; groupIds: string[] }

/** The stages a guardrail runs on; what it asks after that lives in its condition blocks. */
function triggerText(graph: PolicyGraph): string {
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  const stages = trigger?.type === 'trigger' ? trigger.stages : []
  if (stages.length === 0) return 'Any stage'
  return stages.map((k) => kindLabels[k]).join(', ')
}

function GuardrailsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [guardrails, groups, servers, resources] = useQueries({
    queries: [guardrailsQuery, groupsQuery, serversQuery, resourcesQuery],
  })
  const [creating, setCreating] = useState<{ name: string; copyOf: string } | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)

  const list = guardrails.data ?? []
  const groupList = groups.data ?? []
  const names: Record<string, string> = {
    ...Object.fromEntries(groupList.map((g) => [g.id, g.name])),
    ...Object.fromEntries((servers.data ?? []).map((s) => [s.id, s.name])),
    ...Object.fromEntries((resources.data ?? []).map((r) => [r.id, r.name])),
  }
  const everyoneId = groupList.find((g) => g.isDefault)?.id

  const invalidate = () => qc.invalidateQueries({ queryKey: ['guardrails'] })
  const create = useMutation({
    mutationFn: (d: { name: string; copyOf: string }) =>
      createGuardrail({ data: { name: d.name, copyOf: d.copyOf || undefined } }),
    onSuccess: async ({ id }) => {
      setCreating(null)
      await invalidate()
      await navigate({ to: '/guardrails/$guardrailId', params: { guardrailId: id } })
    },
  })
  const update = useMutation({
    mutationFn: (d: Parameters<typeof updateGuardrail>[0]['data']) => updateGuardrail({ data: d }),
    onSuccess: async () => {
      setSettings(null)
      await invalidate()
    },
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderGuardrails({ data: { ids } }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (guardrailId: string) => deleteGuardrail({ data: { guardrailId } }),
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

  const runsForEveryone = (w: Guardrail) =>
    w.groupIds.length === 0 || (everyoneId != null && w.groupIds.includes(everyoneId))
  // Every stage has a live guardrail that runs for everyone; one guardrail need not cover them all.
  const covered = new Set(
    list.flatMap((w) => {
      const trigger = w.published?.definition.nodes.find((n) => n.type === 'trigger')
      if (!w.enabled || trigger?.type !== 'trigger' || !runsForEveryone(w)) return []
      return trigger.stages.length === 0 ? eventKind.options : trigger.stages
    }),
  )
  const catchAll = eventKind.options.every((stage) => covered.has(stage))

  return (
    <>
      <PageHeader
        title="Guardrails"
        description="Define how agent requests are checked, approved, and blocked."
        details="Every enabled guardrail that runs on the request's stage, and whose groups include the user, runs. The strictest outcome wins: block, then approval, then allow; a guardrail that ends in Skip does not count."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setCreating({ name: '', copyOf: '' })}>
              <Plus /> New guardrail
            </Button>
          ) : null
        }
      />
      {!catchAll && list.length > 0 ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Some stages have no live guardrail that runs for every member. A request that starts no
            guardrail is allowed without any checks, including the device fingerprint.
          </span>
        </div>
      ) : null}
      <Card>
        <CardHeader title="All guardrails" actions={<Badge>{list.length} total</Badge>} />
        {list.length === 0 ? (
          <EmptyState
            title="No guardrails"
            description="Without a guardrail every request is allowed. Create one to check tool calls or prompts."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                {isAdmin ? <TH className="w-16" /> : null}
                <TH>Guardrail</TH>
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
                      to="/guardrails/$guardrailId"
                      params={{ guardrailId: w.id }}
                      className="text-sm font-medium hover:text-accent-strong"
                    >
                      {w.name}
                    </Link>
                    {w.description ? (
                      <div className="mt-1 text-xs text-muted">{w.description}</div>
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
                      onCheckedChange={(enabled) => update.mutate({ guardrailId: w.id, enabled })}
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
                            guardrailId: w.id,
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
        title="New guardrail"
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
        title="Guardrail settings"
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto text-bad"
              disabled={remove.isPending}
              onClick={() =>
                settings &&
                window.confirm(`Delete "${settings.name}" and all its versions?`) &&
                remove.mutate(settings.guardrailId)
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
              hint="Leave every group unticked to run for all members. Which requests start it is set on the first step of the guardrail."
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
