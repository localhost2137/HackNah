import {
  formatAmount,
  type LimitMeasure,
  type LimitRule,
  type LimitScope,
  limitRuleIssue,
  limitWindows,
  usageMeasures,
  windowLabel,
} from '@acl/shared'
import {
  Badge,
  Button,
  Card,
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
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { listGroups, listResources } from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { deleteLimit, limitUsage, listLimits, saveLimit } from '#/server/fns/limits.ts'
import { listModels } from '#/server/fns/models.ts'

const limitsQuery = queryOptions({ queryKey: ['limits'], queryFn: () => listLimits() })
const usageQuery = queryOptions({
  queryKey: ['limits', 'usage'],
  queryFn: () => limitUsage(),
  refetchInterval: 15_000,
})
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })
const groupsQuery = queryOptions({ queryKey: ['groups'], queryFn: () => listGroups() })
const modelsQuery = queryOptions({ queryKey: ['models'], queryFn: () => listModels() })

export const Route = createFileRoute('/_app/limits')({
  loader: ({ context: { queryClient } }) =>
    Promise.all(
      [limitsQuery, serversQuery, resourcesQuery, groupsQuery, modelsQuery].map((q) =>
        queryClient.ensureQueryData(q as typeof limitsQuery),
      ),
    ),
  component: LimitsPage,
})

type Draft = Omit<LimitRule, 'id'> & { id?: string; enabled: boolean }

const measures: { value: LimitMeasure; label: string; unit: string }[] = [
  { value: 'requests', label: 'Requests', unit: 'Max requests' },
  { value: 'concurrent', label: 'Requests at once', unit: 'Max at once' },
  { value: 'cost', label: 'Spend (USD)', unit: 'Max USD' },
  { value: 'tokens', label: 'Tokens', unit: 'Max tokens' },
  { value: 'gpu_seconds', label: 'GPU time (seconds)', unit: 'Max GPU-seconds' },
]

const scopeLabels: Record<LimitScope, string> = {
  model: 'Models',
  guardrails: 'Guardrails (judge calls)',
  mcp: 'MCP server',
  tool: 'Tool',
  resource: 'Resource',
}

function scopesFor(measure: LimitMeasure): LimitScope[] {
  if (usageMeasures.includes(measure)) return ['model', 'guardrails']
  if (measure === 'concurrent') return ['model', 'mcp', 'tool', 'resource']
  return ['model', 'tool', 'mcp', 'resource', 'guardrails']
}

const actionLabels: Record<LimitRule['action'], string> = {
  block: 'Block',
  warn: 'Warn only',
  workflow: 'Workflow decides',
}

function LimitsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [limits, usage, servers, resources, groups, models] = useQueries({
    queries: [limitsQuery, usageQuery, serversQuery, resourcesQuery, groupsQuery, modelsQuery],
  })
  const [draft, setDraft] = useState<Draft | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['limits'] })
  const save = useMutation({
    mutationFn: (d: Draft) => saveLimit({ data: d }),
    onSuccess: async () => {
      setDraft(null)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteLimit({ data: { id } }),
    onSuccess: invalidate,
  })
  const toggle = useMutation({
    mutationFn: (d: Draft) => saveLimit({ data: d }),
    onSuccess: invalidate,
  })

  const serverList = servers.data ?? []
  const resourceList = resources.data ?? []
  const groupList = groups.data ?? []
  const toolNames = serverList.flatMap((s) => s.tools.map((t) => `${s.slug}__${t.name}`))
  const modelPatterns = (models.data ?? []).map((m) => m.pattern)
  const groupName = (id: string | null) => {
    const g = groupList.find((x) => x.id === id)
    return g ? (g.isDefault ? 'All members' : g.name) : 'a deleted group'
  }

  const targetLabel = (r: { scope: LimitScope; target: string }) => {
    if (r.target === '*') return `every ${scopeLabels[r.scope].toLowerCase()}`
    if (r.scope === 'mcp') return serverList.find((s) => s.id === r.target)?.name ?? r.target
    if (r.scope === 'resource') return resourceList.find((x) => x.id === r.target)?.name ?? r.target
    return r.target
  }
  const perLabel = (r: Pick<LimitRule, 'per' | 'groupId'>) =>
    r.per === 'user'
      ? 'each user'
      : r.per === 'group_member'
        ? `each member of ${groupName(r.groupId)}`
        : r.per === 'group_total'
          ? `${groupName(r.groupId)} in total`
          : 'whole organization'

  const issue = draft ? limitRuleIssue(draft) : null
  const measure = measures.find((m) => m.value === draft?.measure)

  return (
    <>
      <PageHeader
        title="Limits"
        description="Request rates, concurrency and budgets in USD, tokens or GPU time, per user, per group or for the whole organization. Checked at the gateway before the workflows run; spend is added once the model answers."
        actions={
          isAdmin ? (
            <Button
              variant="primary"
              onClick={() =>
                setDraft({
                  name: '',
                  measure: 'cost',
                  scope: 'model',
                  target: '*',
                  limit: 10,
                  windowSec: 86_400,
                  per: 'user',
                  groupId: null,
                  action: 'block',
                  warnAtPct: 80,
                  enabled: true,
                })
              }
            >
              <Plus /> New limit
            </Button>
          ) : null
        }
      />
      <Card>
        {(limits.data ?? []).length === 0 ? (
          <EmptyState
            title="No limits"
            description="For example: $5 of model spend per user per day, 1 GPU-hour per day for interns, or 20 github__create_issue calls per hour."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Limit</TH>
                <TH>Applies to</TH>
                <TH>Counted for</TH>
                <TH>Used now</TH>
                <TH>When exceeded</TH>
                <TH>Enabled</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {limits.data!.map((r) => {
                const used = usage.data?.[r.id]
                const pct = used === undefined ? null : Math.min(100, (used / r.limit) * 100)
                return (
                  <TR key={r.id}>
                    <TD className="text-xs">
                      {r.name ? <div className="font-medium">{r.name}</div> : null}
                      <span className="font-mono">
                        {formatAmount(r.measure, r.limit)}
                        {r.measure === 'concurrent' ? '' : ` / ${windowLabel(r.windowSec)}`}
                      </span>
                    </TD>
                    <TD className="text-xs">
                      <Badge className="mr-2">{scopeLabels[r.scope]}</Badge>
                      <span
                        className={
                          r.scope === 'tool' || r.scope === 'model' ? 'font-mono' : undefined
                        }
                      >
                        {targetLabel(r)}
                      </span>
                    </TD>
                    <TD className="text-xs text-muted">{perLabel(r)}</TD>
                    <TD className="w-40 text-xs">
                      {pct === null ? (
                        <span className="text-subtle">per person</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
                            <span
                              className={`block h-full rounded-full ${pct >= 100 ? 'bg-bad' : pct >= r.warnAtPct ? 'bg-warn' : 'bg-ok'}`}
                              style={{ width: `${Math.max(3, pct)}%` }}
                            />
                          </span>
                          <span className="font-mono text-[11px] text-muted">
                            {formatAmount(r.measure, used ?? 0)}
                          </span>
                        </div>
                      )}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          r.action === 'block' ? 'bad' : r.action === 'warn' ? 'warn' : 'accent'
                        }
                      >
                        {actionLabels[r.action]}
                      </Badge>
                    </TD>
                    <TD>
                      <Switch
                        checked={r.enabled}
                        disabled={!isAdmin}
                        onCheckedChange={(enabled) => toggle.mutate({ ...r, enabled })}
                        label="Enabled"
                      />
                    </TD>
                    {isAdmin ? (
                      <TD className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setDraft({ ...r })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}>
                          Delete
                        </Button>
                      </TD>
                    ) : null}
                  </TR>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Sheet
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? 'Edit limit' : 'New limit'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !draft?.target || issue !== null}
              onClick={() => draft && save.mutate(draft)}
            >
              Save
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-4">
            <Field label="Name" hint="Shown in the Usage limit block and in blocked requests.">
              <Input
                value={draft.name}
                placeholder="Daily model budget"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Measure">
                <Select
                  value={draft.measure}
                  onChange={(e) => {
                    const next = e.target.value as LimitMeasure
                    const scope = scopesFor(next).includes(draft.scope)
                      ? draft.scope
                      : scopesFor(next)[0]!
                    setDraft({ ...draft, measure: next, scope })
                  }}
                >
                  {measures.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Applies to">
                <Select
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft({ ...draft, scope: e.target.value as LimitScope, target: '*' })
                  }
                >
                  {scopesFor(draft.measure).map((s) => (
                    <option key={s} value={s}>
                      {scopeLabels[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              label={draft.scope === 'model' || draft.scope === 'guardrails' ? 'Models' : 'Target'}
              hint={
                draft.scope === 'model' || draft.scope === 'guardrails'
                  ? 'Glob over model ids. Usage of every matching model adds up to one budget.'
                  : draft.target === '*'
                    ? 'A wildcard counts each target separately (100/min means 100 per tool).'
                    : undefined
              }
            >
              {draft.scope === 'tool' || draft.scope === 'model' || draft.scope === 'guardrails' ? (
                <>
                  <Input
                    list="limit-targets"
                    className="font-mono"
                    value={draft.target}
                    onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                  />
                  <datalist id="limit-targets">
                    <option value="*" />
                    {(draft.scope === 'tool' ? toolNames : modelPatterns).map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </>
              ) : (
                <Select
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                >
                  <option value="*">Any</option>
                  {(draft.scope === 'mcp' ? serverList : resourceList).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={measure?.unit ?? 'Limit'}>
                <Input
                  type="number"
                  min={0}
                  step={draft.measure === 'cost' ? 0.01 : 1}
                  value={draft.limit}
                  onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })}
                />
              </Field>
              {draft.measure === 'concurrent' ? null : (
                <Field label="Per">
                  <Select
                    value={draft.windowSec}
                    onChange={(e) => setDraft({ ...draft, windowSec: Number(e.target.value) })}
                  >
                    {limitWindows.map((w) => (
                      <option key={w.value} value={w.value}>
                        {w.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <Field
              label="Counted for"
              hint="A user in several groups gets every limit that applies; the strictest one blocks."
            >
              <Select
                value={draft.per}
                onChange={(e) => {
                  const per = e.target.value as Draft['per']
                  const grouped = per === 'group_member' || per === 'group_total'
                  setDraft({
                    ...draft,
                    per,
                    groupId: grouped ? (draft.groupId ?? groupList[0]?.id ?? null) : null,
                  })
                }}
              >
                <option value="user">Each user separately</option>
                <option value="group_member">Each member of a group separately</option>
                <option value="group_total">A group in total</option>
                <option value="org">The whole organization</option>
              </Select>
            </Field>
            {draft.per === 'group_member' || draft.per === 'group_total' ? (
              <Field label="Group">
                <Select
                  value={draft.groupId ?? ''}
                  onChange={(e) => setDraft({ ...draft, groupId: e.target.value || null })}
                >
                  {groupList.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.isDefault ? 'All members' : g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <div className="grid grid-cols-2 gap-4">
              <Field label="When exceeded">
                <Select
                  value={draft.action}
                  onChange={(e) =>
                    setDraft({ ...draft, action: e.target.value as Draft['action'] })
                  }
                >
                  <option value="block">Block the request</option>
                  <option value="warn">Allow, flag in the log</option>
                  <option value="workflow">Let the workflow decide</option>
                </Select>
              </Field>
              <Field label="Near limit at (%)">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.warnAtPct}
                  onChange={(e) => setDraft({ ...draft, warnAtPct: Number(e.target.value) })}
                />
              </Field>
            </div>
            {draft.action === 'workflow' ? (
              <p className="text-xs text-muted">
                Add a Usage limit block to a workflow and pick this limit. It leaves through Under
                limit, Near limit or Over limit, so you can route an over-budget request to an
                approval instead of a hard block.
              </p>
            ) : null}
            <FormError message={issue ?? save.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
