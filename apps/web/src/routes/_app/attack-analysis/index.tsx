import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowUpRight, Database, Search } from 'lucide-react'
import { useState } from 'react'
import { datasets } from '#/lib/attack-analysis/datasets.ts'
import { useAnalysisRuns } from '#/lib/attack-analysis/runs.ts'

export const Route = createFileRoute('/_app/attack-analysis/')({ component: DatasetCatalog })
const PAGE_SIZE = 20

function DatasetCatalog() {
  const { viewer } = Route.useRouteContext()
  const { runs, isPending, error } = useAnalysisRuns(viewer.user.id)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(0)
  const filtered = datasets.filter((dataset) => {
    const hasRun = runs.some((run) => run.datasetId === dataset.id)
    return (
      `${dataset.name} ${dataset.description} ${dataset.tag}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === 'all' || (status === 'completed' ? hasRun : !hasRun))
    )
  })
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  return (
    <>
      <PageHeader
        title="Attack analysis"
        description="Choose a dataset to test your guardrails and explore its results."
      />
      {error ? (
        <p role="alert" className="mb-4 text-xs text-bad">
          Could not load saved runs: {error.message}
        </p>
      ) : null}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Database className="size-4 text-muted" />
            Datasets<span className="ml-1 font-mono text-xs text-subtle">{datasets.length}</span>
          </h2>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-subtle" />
              <Input
                aria-label="Search datasets"
                className="pl-8 sm:w-72"
                placeholder="Search datasets…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
              />
            </div>
            <Select
              aria-label="Filter datasets by run status"
              className="w-36"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(0)
              }}
            >
              <option value="all">All datasets</option>
              <option value="completed">Has results</option>
              <option value="new">Not run yet</option>
            </Select>
          </div>
        </div>
        <Table>
          <THead>
            <tr>
              <TH>Dataset</TH>
              <TH>Type</TH>
              <TH>Events</TH>
              <TH>Last run</TH>
              <TH>Result</TH>
              <TH>
                <span className="sr-only">Open dataset</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((dataset) => {
              const run = runs.find((r) => r.datasetId === dataset.id)
              const correct = run?.correct ?? 0
              return (
                <TR key={dataset.id}>
                  <TD>
                    <Link
                      to="/attack-analysis/$datasetId"
                      params={{ datasetId: dataset.id }}
                      className="text-sm font-medium hover:text-accent-strong"
                    >
                      {dataset.name}
                    </Link>
                    <p className="mt-1 text-xs text-muted">{dataset.description}</p>
                  </TD>
                  <TD>
                    <Badge>{dataset.tag}</Badge>
                  </TD>
                  <TD className="font-mono text-xs text-muted">
                    {dataset.eventCount.toLocaleString()}
                  </TD>
                  <TD className="text-xs text-muted">
                    {run
                      ? new Date(run.at).toLocaleString()
                      : isPending
                        ? 'Loading…'
                        : 'Not run yet'}
                  </TD>
                  <TD>
                    {run ? (
                      <Badge tone={correct === run.total ? 'ok' : 'warn'}>
                        {correct}/{run.total} as expected
                      </Badge>
                    ) : (
                      <span className="text-xs text-subtle">—</span>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Link
                      to="/attack-analysis/$datasetId"
                      params={{ datasetId: dataset.id }}
                      aria-label={`Open ${dataset.name}`}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-fg"
                    >
                      {run ? 'View results' : 'Open'}
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
        {!filtered.length ? (
          <div className="px-6 py-14 text-center">
            <h3 className="text-sm font-medium">No matching datasets</h3>
            <p className="mt-2 text-xs text-muted">
              Try another search or change the status filter.
            </p>
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-xs text-subtle">
          <span>{filtered.length} datasets · Synthetic events with benign controls</span>
          {pages > 1 ? (
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                {page + 1} / {pages}
              </span>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
      <p className="mt-4 text-[11px] text-subtle">
        Results are saved across sessions. Changes to guardrail rules invalidate all previous
        results.
      </p>
    </>
  )
}
