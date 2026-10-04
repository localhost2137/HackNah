import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Play, Plus, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { HuggingFaceImport } from '#/components/hf-import.tsx'
import { datasets as syntheticDatasets } from '#/lib/attack-analysis/datasets.ts'
import { labelledInfo } from '#/lib/attack-analysis/labelled.ts'
import { useAnalysisRuns } from '#/lib/attack-analysis/runs.ts'
import { datasetRowsQuery, datasetsQuery } from '#/lib/datasets.ts'
import { num } from '#/lib/format.ts'
import { type DatasetSummary, uploadDataset } from '#/server/fns/datasets.ts'

export const Route = createFileRoute('/_app/datasets')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(datasetsQuery),
  component: DatasetsPage,
})

const label = (key: string) => key.replace(/_/g, ' ')

/** Rows of an uploaded file: JSON lines or a JSON array of `{text, label}`. */
function parseUpload(content: string): { text: string; attack: boolean }[] {
  const trimmed = content.trim()
  const records: unknown[] = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
  const benign = new Set(['0', 'false', 'benign', 'safe', 'ok', 'allow'])
  return records.flatMap((record) => {
    const r = record as Record<string, unknown>
    const text = r.text ?? r.prompt ?? r.input
    if (typeof text !== 'string' || !text.trim()) return []
    const mark = r.attack ?? r.label ?? r.type ?? r.expected
    return [{ text, attack: !benign.has(String(mark).toLowerCase()) }]
  })
}

type Kind = 'Mixed' | 'Benign' | 'Synthetic' | 'Labelled' | 'Uploaded'
type Entry = {
  /** The id Attack analysis runs it under. */
  id: string
  name: string
  description: string
  kind: Kind
  rows: number
  attacks: number | null
  benign: number | null
  summary: DatasetSummary | null
}

const kindTone: Record<Kind, 'accent' | 'ok' | 'info' | 'neutral'> = {
  Mixed: 'accent',
  Benign: 'ok',
  Synthetic: 'info',
  Labelled: 'neutral',
  Uploaded: 'neutral',
}
// Quick checks first, then the sets built to measure one thing, then the source datasets.
const kindOrder: Kind[] = ['Mixed', 'Benign', 'Synthetic', 'Uploaded', 'Labelled']

function DatasetsPage() {
  const { viewer } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data } = useQuery(datasetsQuery)
  const { runs } = useAnalysisRuns(viewer.user.id)
  const [open, setOpen] = useState<DatasetSummary | null>(null)
  const [search, setSearch] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['datasets'] })
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const rows = parseUpload(await file.text())
      if (rows.length === 0) throw new Error('No rows with a "text" field found in that file')
      return uploadDataset({ data: { name: file.name.replace(/\.[^.]+$/, ''), rows } })
    },
    onSuccess: async () => {
      setUploadError(null)
      await refresh()
    },
    onError: (err) => setUploadError(err instanceof Error ? err.message : String(err)),
  })

  const models = data?.models ?? []
  const entries: Entry[] = [
    ...(data?.datasets ?? []).map((d): Entry => {
      const info = labelledInfo(d)
      return {
        id: info.id,
        name: d.name,
        description: d.slug.startsWith('mixed-')
          ? 'Half attacks of every kind, half normal requests. Rerun it after changing a workflow.'
          : info.description,
        kind: d.slug.startsWith('mixed-')
          ? 'Mixed'
          : d.attacks === 0
            ? 'Benign'
            : d.custom
              ? 'Uploaded'
              : 'Labelled',
        rows: d.rows,
        attacks: d.attacks,
        benign: d.benign,
        summary: d,
      }
    }),
    ...syntheticDatasets.map(
      (d): Entry => ({
        id: d.id,
        name: d.name,
        description: d.description,
        kind: 'Synthetic',
        rows: d.eventCount,
        attacks: null,
        benign: null,
        summary: null,
      }),
    ),
  ]
    .filter((e) =>
      `${e.name} ${e.description} ${e.kind}`.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind))

  return (
    <>
      <PageHeader
        title="Attack analysis"
        description="Datasets of attack and normal requests to test your workflows against. Run one to see what your rules block, miss or block by mistake. Labelled datasets can also train a model in a Trained model step."
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) upload.mutate(file)
                e.target.value = ''
              }}
            />
            <Button disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
              <Upload /> {upload.isPending ? 'Uploading…' : 'Upload file'}
            </Button>
            <Button variant="primary" onClick={() => setImporting(true)}>
              <Plus /> Add from Hugging Face
            </Button>
          </>
        }
      />
      {uploadError ? (
        <div className="mb-4">
          <FormError message={uploadError} />
        </div>
      ) : null}

      <Card>
        <div className="border-b border-line p-3">
          <Input
            aria-label="Search datasets"
            placeholder="Search datasets"
            className="max-w-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {entries.length === 0 ? (
          <EmptyState
            title="No matching datasets"
            description={
              <>
                Run <span className="font-mono">pnpm datasets:upload</span> to load the labelled
                datasets shipped in the repository.
              </>
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Dataset</TH>
                <TH>Kind</TH>
                <TH>Rows</TH>
                <TH>Attacks</TH>
                <TH>Normal</TH>
                <TH>Last run</TH>
                <TH>Used by models</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {entries.map((e) => {
                const run = runs.find((r) => r.datasetId === e.id)
                return (
                  <TR key={e.id}>
                    <TD className="max-w-md">
                      <Link
                        to="/attack-analysis/$datasetId"
                        params={{ datasetId: e.id }}
                        className="text-xs font-medium hover:underline"
                      >
                        {e.name}
                      </Link>
                      <div
                        className="mt-0.5 truncate text-[11px] text-subtle"
                        title={e.description}
                      >
                        {e.description}
                      </div>
                    </TD>
                    <TD>
                      <Badge tone={kindTone[e.kind]}>{e.kind}</Badge>
                    </TD>
                    <TD className="font-mono text-xs">{num(e.rows)}</TD>
                    <TD className="font-mono text-xs">
                      {e.attacks === null ? '—' : num(e.attacks)}
                    </TD>
                    <TD className="font-mono text-xs">{e.benign === null ? '—' : num(e.benign)}</TD>
                    <TD>
                      {run ? (
                        <Badge tone={run.correct === run.total ? 'ok' : 'warn'}>
                          {run.correct}/{run.total} as expected
                        </Badge>
                      ) : (
                        <span className="text-xs text-subtle">Not run yet</span>
                      )}
                    </TD>
                    <TD className="font-mono text-xs">
                      {e.summary
                        ? models.filter((m) => m.datasets.includes(e.summary!.slug)).length || '—'
                        : '—'}
                    </TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        {e.summary ? (
                          <Button size="sm" variant="ghost" onClick={() => setOpen(e.summary)}>
                            Rows
                          </Button>
                        ) : null}
                        <Link to="/attack-analysis/$datasetId" params={{ datasetId: e.id }}>
                          <Button size="sm">
                            <Play /> {run ? 'Results' : 'Run'}
                          </Button>
                        </Link>
                      </div>
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {open ? <DatasetSheet key={open.slug} dataset={open} onClose={() => setOpen(null)} /> : null}
      <HuggingFaceImport
        open={importing}
        onClose={() => setImporting(false)}
        onImported={refresh}
      />
    </>
  )
}

function DatasetSheet({ dataset, onClose }: { dataset: DatasetSummary; onClose: () => void }) {
  const rows = useQuery(datasetRowsQuery(dataset.slug))
  return (
    <Sheet
      open
      wide
      onOpenChange={(next) => (next ? null : onClose())}
      title={dataset.name}
      description={
        dataset.url ? (
          <a
            href={dataset.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent-strong hover:underline"
          >
            {dataset.url}
          </a>
        ) : (
          dataset.license
        )
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-3 gap-3 text-xs">
          <Count label="Rows" value={dataset.rows} />
          <Count label="Attacks" value={dataset.attacks} />
          <Count label="Benign" value={dataset.benign} />
        </div>
        <div className="flex flex-col gap-2 text-xs">
          <Breakdown title="Attack types" counts={dataset.byAttack} />
          <Breakdown title="Arrives through" counts={dataset.byChannel} />
        </div>
        <p className="text-xs text-muted">
          {dataset.attacks > 0
            ? 'Run it from the list to see how your workflows do on it. To block requests like these, add a Trained model step to a workflow and tick this dataset there.'
            : 'This dataset has no attack rows. Its rows serve as benign examples when models are trained on other datasets.'}
        </p>
        <div>
          <div className="mb-2 text-xs font-medium">Sample rows</div>
          {rows.isPending ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {(rows.data ?? []).slice(0, 12).map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                <li key={i} className="flex items-start gap-3 px-3 py-2">
                  <Badge tone={row.attack === 'benign' ? 'ok' : 'bad'}>{label(row.attack)}</Badge>
                  <span className="line-clamp-2 min-w-0 flex-1 font-mono text-[11px] break-words text-muted">
                    {row.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  )
}

function Count({ label: title, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <div className="text-[11px] text-muted">{title}</div>
      <div className="mt-0.5 font-mono text-sm">{num(value)}</div>
    </div>
  )
}

function Breakdown({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts)
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-28 text-muted">{title}</span>
      {entries.map(([kind, n]) => (
        <Badge key={kind}>
          {label(kind)} · {num(n)}
        </Badge>
      ))}
    </div>
  )
}
