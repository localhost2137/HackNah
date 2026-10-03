import type { RateLimitRule } from '@acl/shared'
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
import { listResources } from '#/server/fns/access.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { deleteRateLimit, listRateLimits, saveRateLimit } from '#/server/fns/rate-limits.ts'

const limitsQuery = queryOptions({ queryKey: ['rate-limits'], queryFn: () => listRateLimits() })
const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
const resourcesQuery = queryOptions({ queryKey: ['resources'], queryFn: () => listResources() })

export const Route = createFileRoute('/_app/rate-limits')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(limitsQuery),
      queryClient.ensureQueryData(serversQuery),
      queryClient.ensureQueryData(resourcesQuery),
    ]),
  component: RateLimitsPage,
})

type Draft = Omit<RateLimitRule, 'id'> & { id?: string; enabled: boolean }

const windows = [
  { value: 60, label: 'minute' },
  { value: 3600, label: 'hour' },
  { value: 86_400, label: 'day' },
]
const windowLabel = (sec: number) => windows.find((w) => w.value === sec)?.label ?? `${sec}s`

function RateLimitsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const [limits, servers, resources] = useQueries({
    queries: [limitsQuery, serversQuery, resourcesQuery],
  })
  const [draft, setDraft] = useState<Draft | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['rate-limits'] })
  const save = useMutation({
    mutationFn: (d: Draft) => saveRateLimit({ data: d }),
    onSuccess: async () => {
      setDraft(null)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteRateLimit({ data: { id } }),
    onSuccess: invalidate,
  })
  const toggle = useMutation({
    mutationFn: (d: Draft) => saveRateLimit({ data: d }),
    onSuccess: invalidate,
  })

  const serverList = servers.data ?? []
  const resourceList = resources.data ?? []
  const toolNames = serverList.flatMap((s) => s.tools.map((t) => `${s.slug}__${t.name}`))

  const targetLabel = (r: { scope: string; target: string }) => {
    if (r.target === '*') return `every ${r.scope === 'mcp' ? 'MCP server' : r.scope}`
    if (r.scope === 'mcp') return serverList.find((s) => s.id === r.target)?.name ?? r.target
    if (r.scope === 'resource') return resourceList.find((x) => x.id === r.target)?.name ?? r.target
    return r.target
  }

  return (
    <>
      <PageHeader
        title="Rate limits"
        description="Caps on MCP tool calls per server, tool or resource. Sliding window, enforced at the gateway before the workflow runs."
        actions={
          isAdmin ? (
            <Button
              variant="primary"
              onClick={() =>
                setDraft({
                  scope: 'tool',
                  target: '*',
                  limit: 60,
                  windowSec: 60,
                  per: 'user',
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
            title="No rate limits"
            description="For example: at most 20 github__create_issue calls per user per hour."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Applies to</TH>
                <TH>Limit</TH>
                <TH>Counted per</TH>
                <TH>Enabled</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {limits.data!.map((r) => (
                <TR key={r.id}>
                  <TD className="text-xs">
                    <Badge className="mr-2">{r.scope}</Badge>
                    <span className={r.scope === 'tool' && r.target !== '*' ? 'font-mono' : ''}>
                      {targetLabel(r)}
                    </span>
                  </TD>
                  <TD className="font-mono text-xs">
                    {r.limit} / {windowLabel(r.windowSec)}
                  </TD>
                  <TD className="text-xs text-muted">
                    {r.per === 'user' ? 'each user' : 'whole organization'}
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
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Sheet
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? 'Edit rate limit' : 'New rate limit'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !draft?.target}
              onClick={() => draft && save.mutate(draft)}
            >
              Save
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-4">
            <Field label="Scope">
              <Select
                value={draft.scope}
                onChange={(e) =>
                  setDraft({ ...draft, scope: e.target.value as Draft['scope'], target: '*' })
                }
              >
                <option value="tool">Tool</option>
                <option value="mcp">MCP server</option>
                <option value="resource">Resource</option>
              </Select>
            </Field>
            <Field
              label="Target"
              hint={
                draft.target === '*'
                  ? 'Wildcard rules count each target separately (100/min means 100 per tool).'
                  : undefined
              }
            >
              {draft.scope === 'tool' ? (
                <>
                  <Input
                    list="tool-names"
                    value={draft.target}
                    onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                  />
                  <datalist id="tool-names">
                    <option value="*" />
                    {toolNames.map((t) => (
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
              <Field label="Max calls">
                <Input
                  type="number"
                  min={1}
                  value={draft.limit}
                  onChange={(e) => setDraft({ ...draft, limit: Number(e.target.value) })}
                />
              </Field>
              <Field label="Per">
                <Select
                  value={draft.windowSec}
                  onChange={(e) => setDraft({ ...draft, windowSec: Number(e.target.value) })}
                >
                  {windows.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Count">
              <Select
                value={draft.per}
                onChange={(e) => setDraft({ ...draft, per: e.target.value as Draft['per'] })}
              >
                <option value="user">Separately for each user</option>
                <option value="org">For the whole organization</option>
              </Select>
            </Field>
            <FormError message={save.error?.message ?? null} />
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
