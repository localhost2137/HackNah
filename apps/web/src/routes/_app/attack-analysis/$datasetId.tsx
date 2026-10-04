import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Sheet,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Download,
  LoaderCircle,
  Play,
  SlidersHorizontal,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { CoverageCharts } from '#/components/attack-analysis/coverage.tsx'
import { AnalysisResults } from '#/components/attack-analysis/results.tsx'
import { TrafficChart } from '#/components/attack-analysis/traffic-chart.tsx'
import { CheckList, JsonBlock } from '#/components/event-bits.tsx'
import { datasets, trafficWindow } from '#/lib/attack-analysis/datasets.ts'
import {
  type DatasetInfo,
  isLabelled,
  labelledInfo,
  labelledSlug,
  labelledTraffic,
} from '#/lib/attack-analysis/labelled.ts'
import type { Actual, Outcome } from '#/lib/attack-analysis/replay.ts'
import { type AnalysisRun, useAnalysisRun, useAnalysisRuns } from '#/lib/attack-analysis/runs.ts'
import { datasetTraffic } from '#/lib/attack-analysis/traffic.ts'
import { datasetRowsQuery, datasetsQuery } from '#/lib/datasets.ts'
import { listGroups, listResources } from '#/server/fns/access.ts'
import { runAnalysis } from '#/server/fns/attack-analysis.ts'
import { listMcpServers } from '#/server/fns/integrations.ts'
import { listWorkflows } from '#/server/fns/workflow.ts'

export const Route = createFileRoute('/_app/attack-analysis/$datasetId')({
  beforeLoad: ({ params }) => {
    if (!isLabelled(params.datasetId) && !datasets.some((d) => d.id === params.datasetId))
      throw notFound()
  },
  component: DatasetRoute,
})

function DatasetRoute() {
  const { datasetId } = Route.useParams()
  return <AttackAnalysisPage key={datasetId} datasetId={datasetId} />
}

const actualLabels: Record<Actual, string> = {
  block: 'Block',
  allow: 'Allow',
  approval: 'Approval',
  inconclusive: 'Inconclusive',
}
const outcomeLabels: Record<Outcome, string> = {
  correct: 'As expected',
  missed: 'Missed attack',
  overblocked: 'Overblocked',
  review: 'Needs approval',
  inconclusive: 'Inconclusive',
}
const outcomeTones = {
  correct: 'ok',
  missed: 'bad',
  overblocked: 'bad',
  review: 'warn',
  inconclusive: 'neutral',
} as const

function AttackAnalysisPage({ datasetId }: { datasetId: string }) {
  const { viewer } = Route.useRouteContext()
  const persisted = useAnalysisRuns(viewer.user.id)
  const allRuns = persisted.runs
  const runs = allRuns.filter((r) => r.datasetId === datasetId)
  // A labelled dataset comes from the bucket; its rows are fetched before they can be shown.
  const labelled = isLabelled(datasetId)
  const slug = labelledSlug(datasetId)
  const catalog = useQuery({ ...datasetsQuery, enabled: labelled })
  const labelledRows = useQuery({ ...datasetRowsQuery(slug), enabled: labelled })
  const labelledSummary = catalog.data?.datasets.find((d) => d.slug === slug)
  const dataset: DatasetInfo = labelled
    ? labelledSummary
      ? labelledInfo(labelledSummary)
      : {
          id: datasetId,
          name: slug,
          description: catalog.isPending ? 'Loading…' : 'This dataset is no longer available.',
          tag: 'Labelled',
          eventCount: 0,
          templatePrefix: '',
          seed: 0,
          labelled: true,
        }
    : datasets.find((d) => d.id === datasetId)!
  const traffic = useMemo(
    () =>
      labelled
        ? labelledSummary && labelledRows.data
          ? labelledTraffic(labelledInfo(labelledSummary), labelledRows.data)
          : []
        : datasetTraffic(datasetId),
    [labelled, labelledSummary, labelledRows.data, datasetId],
  )
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => listGroups() })
  const servers = useQuery({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => listResources() })
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => listWorkflows() })
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [serverId, setServerId] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [model, setModel] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('all')
  const [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [trafficSearch, setTrafficSearch] = useState('')
  const [trafficPage, setTrafficPage] = useState(0)
  const summary = runs.find((r) => r.id === runId) ?? runs[0]
  const loaded = useAnalysisRun(viewer.user.id, persisted.revision, summary?.id)
  const run = summary && loaded.data?.revision === persisted.revision ? loaded.data : undefined
  const resultById = useMemo(() => new Map(run?.results.map((r) => [r.eventId, r]) ?? []), [run])
  const entry = traffic.find((c) => c.id === selected)
  const detail = run?.results.find((r) => r.eventId === selected)
  const rows = useMemo(
    () =>
      traffic
        .filter(
          (event) =>
            `${event.id} ${event.title} ${event.actor.name} ${event.actor.email} ${event.sessionId} ${event.input.model} ${event.variant}`
              .toLowerCase()
              .includes(trafficSearch.toLowerCase()) &&
            (outcomeFilter === 'all' || resultById.get(event.id)?.outcome === outcomeFilter),
        )
        .reverse(),
    [traffic, trafficSearch, outcomeFilter, resultById],
  )
  const trafficPageCount = Math.max(1, Math.ceil(rows.length / 25))
  const visibleRows = rows.slice(trafficPage * 25, (trafficPage + 1) * 25)
  const loadError =
    persisted.error ??
    loaded.error ??
    groups.error ??
    workflows.error ??
    servers.error ??
    resources.error

  async function startRun() {
    setBusy(true)
    setError(null)
    try {
      const json = await runAnalysis({
        data: {
          datasetId,
          groupIds,
          mcpServerId: serverId || null,
          resourceIds: resourceId ? [resourceId] : [],
          model: model.trim(),
        },
      })
      const next = JSON.parse(json) as AnalysisRun
      await persisted.savedRun(next)
      setRunId(next.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run or save the analysis.')
      await persisted.refresh()
    } finally {
      setBusy(false)
    }
  }

  function exportRun() {
    if (!run) return
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              ...run,
              events: traffic,
            },
            null,
            2,
          ),
        ],
        {
          type: 'application/json',
        },
      ),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `attack-analysis-${run.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Link
        to="/datasets"
        className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        Attack analysis
      </Link>
      <PageHeader
        title={dataset.name}
        description={dataset.description}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
              <SlidersHorizontal />
              Settings
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                !traffic.length ||
                groups.isPending ||
                workflows.isPending ||
                persisted.isPending ||
                Boolean(loadError)
              }
              onClick={startRun}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
              {busy ? 'Running & saving…' : run ? 'Run again' : 'Run dataset'}
            </Button>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3 text-xs text-muted">
        <Badge>{dataset.tag}</Badge>
        <span>{traffic.length.toLocaleString()} events</span>
        <span className="text-line-strong">/</span>
        <span>
          {traffic.filter((c) => c.expected === 'block').length.toLocaleString()} attack events
        </span>
        <span>
          {traffic.filter((c) => c.expected === 'allow').length.toLocaleString()} legitimate
          requests
        </span>
        <span>24h · 36 synthetic identities</span>
        <span className="ml-auto text-[11px] text-subtle">
          {run ? `Last run ${new Date(run.at).toLocaleString()}` : 'Not run yet'}
        </span>
      </div>
      {loadError || error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-bad/20 bg-bad-soft px-4 py-3 text-xs text-bad"
        >
          {error ?? loadError?.message}
        </p>
      ) : null}
      <p className="mb-4 text-[11px] text-subtle">
        {dataset.labelled
          ? 'Labelled rows from the dataset, spread over one synthetic day. '
          : `Synthetic traffic window: ${trafficWindow.start.slice(0, 10)} · UTC. Seed ${dataset.seed}. `}
        The same events are used on every replay.
      </p>
      <TrafficChart traffic={traffic} results={run?.results} />
      <Card className="mt-4 overflow-hidden" aria-busy={busy}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="size-4 text-muted" />
            <h2 className="text-sm font-medium">Results</h2>
            {run ? (
              <span className="ml-1 flex items-center gap-1.5 text-[10px] text-muted">
                <span className="size-1.5 rounded-full bg-ok" />
                Completed
              </span>
            ) : null}
          </div>
          {run ? (
            <div className="flex items-center gap-2">
              <Select
                aria-label="Saved run history"
                className="w-auto border-0 bg-transparent text-xs"
                value={run?.id ?? ''}
                onChange={(e) => setRunId(e.target.value)}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.at).toLocaleTimeString()} · {r.total.toLocaleString()} events
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="icon" aria-label="Export run" onClick={exportRun}>
                <Download />
              </Button>
            </div>
          ) : (
            <span className="text-[11px] text-subtle">
              {persisted.isPending || summary ? 'Loading saved results…' : 'Waiting for first run'}
            </span>
          )}
        </div>
        {run ? (
          <AnalysisResults results={run.results} />
        ) : (
          <div className="relative flex min-h-80 items-center justify-center overflow-hidden px-6 py-12">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-6 opacity-25"
              style={{
                backgroundImage: 'linear-gradient(var(--color-line) 1px, transparent 1px)',
                backgroundSize: '100% 48px',
              }}
            />
            <div className="relative max-w-sm text-center">
              <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border border-line-strong bg-panel shadow-lg">
                <BarChart3 className="size-5 text-muted" />
              </div>
              <h3 className="text-sm font-medium">
                {persisted.isPending || summary
                  ? 'Loading saved results'
                  : 'Ready for its first run'}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {persisted.isPending || summary
                  ? 'Checking stored results against the current rule revision.'
                  : 'Run this dataset against your current guardrails.'}
                <br />
                See what your guardrails catch — and what they miss.
              </p>
            </div>
          </div>
        )}
      </Card>
      {run ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-subtle">
          <span>
            {run.workflows.length} guardrail snapshots · Synthetic traffic ·{' '}
            {run.groupNames.join(', ') || 'No groups'}
          </span>
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="inline-flex items-center gap-1 hover:text-fg"
          >
            Run details
            <ArrowUpRight className="size-3" />
          </button>
        </div>
      ) : null}
      {run ? <CoverageCharts run={run} /> : null}
      <Card className="mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">
            Traffic{' '}
            <span className="ml-1 text-xs text-subtle">{traffic.length.toLocaleString()}</span>
          </h2>
          <Select
            aria-label="Filter traffic outcomes"
            className="sm:ml-auto sm:w-44"
            value={outcomeFilter}
            onChange={(e) => {
              setOutcomeFilter(e.target.value)
              setTrafficPage(0)
            }}
          >
            <option value="all">All outcomes</option>
            {Object.entries(outcomeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Search events"
            className="sm:w-64"
            placeholder="Search event, user, session…"
            value={trafficSearch}
            onChange={(e) => {
              setTrafficSearch(e.target.value)
              setTrafficPage(0)
            }}
          />
        </div>
        <div>
          <Table>
            <THead>
              <tr>
                <TH>Time (UTC)</TH>
                <TH>Request</TH>
                <TH>Synthetic user</TH>
                <TH>Expected</TH>
                <TH>Observed</TH>
                <TH>Result</TH>
              </tr>
            </THead>
            <TBody>
              {visibleRows.map((c) => {
                const result = resultById.get(c.id)
                return (
                  <TR key={c.id}>
                    <TD className="font-mono text-[11px] text-muted">
                      {c.occurredAt.slice(11, 19)}
                    </TD>
                    <TD>
                      <button
                        type="button"
                        className="text-left text-xs font-medium hover:text-accent-strong"
                        onClick={() => setSelected(c.id)}
                      >
                        {c.input.toolName ?? c.input.model}
                      </button>
                      <div className="mt-1 text-[10px] text-subtle">
                        {c.id} · {c.variant}
                      </div>
                    </TD>
                    <TD className="text-xs text-muted">
                      <div>{c.actor.name}</div>
                      <div className="mt-1 font-mono text-[10px] text-subtle">{c.sessionId}</div>
                    </TD>
                    <TD className="text-xs">{actualLabels[c.expected]}</TD>
                    <TD className="text-xs">{result ? actualLabels[result.actual] : '—'}</TD>
                    <TD>
                      {result ? (
                        <Badge tone={outcomeTones[result.outcome]}>
                          {outcomeLabels[result.outcome]}
                        </Badge>
                      ) : (
                        <span className="text-xs text-subtle">Not run</span>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
          {rows.length === 0 ? (
            <p className="p-4 text-xs text-muted">No events match your search.</p>
          ) : null}
        </div>
        {rows.length > 25 ? (
          <div className="flex items-center justify-between border-t border-line p-3 text-xs text-muted">
            <span>
              Page {trafficPage + 1} of {trafficPageCount}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={trafficPage === 0}
                onClick={() => setTrafficPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={trafficPage + 1 >= trafficPageCount}
                onClick={() => setTrafficPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      <p className="mt-4 text-[11px] text-subtle">
        Synthetic replay · No production actions · Curated research datasets
      </p>
      <Sheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="Replay settings"
        description="Defaults are ready to run. Changes apply to your next analysis."
      >
        <p className="mb-5 text-xs leading-relaxed text-muted">
          Each run copies your enabled, published guardrails. Events use synthetic identities and
          recorded device signals; no real user is impersonated.
        </p>
        <div className="grid gap-6">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              Synthetic identities <Badge tone="info">36 test users</Badge>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              All synthetic identities use the selected group memberships for guardrail matching.
              Default groups are included. Each event carries its own device posture, model and
              session signals; identities never impersonate members.
            </p>
            <fieldset disabled={busy} className="flex flex-wrap gap-3">
              <legend className="mb-2 text-xs font-medium text-muted">Group memberships</legend>
              {groups.data?.map((g) => (
                <label key={g.id} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={g.isDefault || groupIds.includes(g.id)}
                    disabled={g.isDefault}
                    onChange={(e) =>
                      setGroupIds((prev) =>
                        e.target.checked ? [...prev, g.id] : prev.filter((id) => id !== g.id),
                      )
                    }
                  />
                  {g.name}
                  {g.isDefault ? ' (default)' : ''}
                </label>
              ))}
              {groups.data?.length === 0 ? (
                <span className="text-xs text-muted">
                  No groups configured; only guardrails scoped to everyone can match.
                </span>
              ) : null}
            </fieldset>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="MCP server context">
              <Select
                disabled={busy}
                value={serverId}
                onChange={(e) => {
                  setServerId(e.target.value)
                  setResourceId('')
                }}
              >
                <option value="">Unmapped synthetic server</option>
                {servers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Resource context">
              <Select
                disabled={busy}
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
              >
                <option value="">No resource mapping</option>
                {resources.data
                  ?.filter((r) => serverId in r.tools || '*' in r.tools)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Model override (optional)" className="sm:col-span-2">
              <Input
                placeholder="Use each event’s model"
                disabled={busy}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-subtle sm:col-span-2">
              Mappings only provide policy context; they grant no access. Tool names and tiers are
              synthetic fixtures. Unmapped server/resource conditions may not match. Access grants,
              rate limits and upstream model behavior are outside this replay.
            </p>
          </div>
        </div>
      </Sheet>
      <Sheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title="Run details"
        description={run ? new Date(run.at).toLocaleString() : undefined}
      >
        {run ? (
          <div className="space-y-5 text-xs">
            <div>
              <h3 className="mb-2 font-medium">Guardrail snapshots</h3>
              {run.workflows.length ? (
                run.workflows.map((w) => (
                  <div key={w.id} className="flex justify-between border-b border-line py-2">
                    <span>{w.name}</span>
                    <span className="font-mono text-muted">v{w.version}</span>
                  </div>
                ))
              ) : (
                <p className="text-warn">
                  No published guardrails. Traffic is allowed without checks.
                </p>
              )}
            </div>
            <p className="leading-relaxed text-muted">
              {run.results.filter((r) => r.result.workflows.length === 0).length} events matched no
              guardrail. LLM judges are not called; unavailable checks are inconclusive. This replay
              evaluates policy decisions, not live model behavior, access grants or rate limits.
            </p>
            <div>
              <h3 className="mb-2 font-medium">Synthetic identity</h3>
              <JsonBlock value={run.persona} />
            </div>
            <p className="text-subtle">
              Catalog {run.catalogVersion} · Rule revision {run.revision}. Results are stored on the
              server. The latest 10 valid runs are listed per dataset. Changing rules invalidates
              every earlier run.
            </p>
            <Button onClick={exportRun}>
              <Download />
              Export run
            </Button>
          </div>
        ) : null}
      </Sheet>
      <Sheet
        open={Boolean(entry)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={entry ? `${entry.input.toolName ?? entry.input.model}` : 'Event'}
        description={
          entry
            ? `${entry.id} · ${dataset.labelled ? 'Labelled row' : 'Synthetic adaptation'} · ${entry.family}`
            : undefined
        }
        wide
      >
        {entry ? (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <dt className="text-subtle">Timestamp (UTC)</dt>
                <dd className="mt-1 font-mono">{entry.occurredAt}</dd>
              </div>
              <div>
                <dt className="text-subtle">Synthetic identity</dt>
                <dd className="mt-1">
                  {entry.actor.name} · {entry.actor.email}
                </dd>
              </div>
              <div>
                <dt className="text-subtle">Session</dt>
                <dd className="mt-1 font-mono">{entry.sessionId}</dd>
              </div>
              <div>
                <dt className="text-subtle">Variant</dt>
                <dd className="mt-1">{entry.variant}</dd>
              </div>
            </dl>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
                Expected: {entry.expected}
              </h3>
              <p className="text-sm">{entry.rationale}</p>
              <p className="mt-2 text-xs text-subtle">
                Catalog-authored expectation, independent of the policy result. Review it against
                your organization’s intended policy.
              </p>
              <a
                href={entry.source.url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-xs text-accent-strong hover:underline"
              >
                {entry.source.title} ↗
              </a>
            </section>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
                {detail ? 'Evaluated input and persona context' : 'Synthetic input template'}
              </h3>
              <JsonBlock value={detail?.input ?? entry.input} />
            </section>
            {detail ? (
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase text-muted">
                    Observed: {actualLabels[detail.actual]}
                  </h3>
                  <Badge tone={outcomeTones[detail.outcome]}>{outcomeLabels[detail.outcome]}</Badge>
                </div>
                {detail.actual === 'inconclusive' ? (
                  <p className="mb-3 text-xs text-warn">
                    A check failed to evaluate or lacked a required signal. The engine’s fallback
                    decision ({detail.result.decision}) is not evidence of detection.
                  </p>
                ) : null}
                <CheckList checks={detail.result.checks} workflows={detail.result.workflows} />
              </section>
            ) : (
              <p className="text-xs text-muted">
                Run analysis to inspect the actual decision path.
              </p>
            )}
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
