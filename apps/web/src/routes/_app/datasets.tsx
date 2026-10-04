import {
  encodeWeights,
  type LabelledText,
  type LearnedModelSummary,
  type TrainProgress,
  type TrainResult,
  trainModel,
} from '@acl/shared'
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
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { BrainCircuit, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { num, timeAgo } from '#/lib/format.ts'
import {
  type DatasetSummary,
  deleteModel,
  getBenignPool,
  getDatasetRows,
  listDatasets,
  saveModel,
  setModelEnabled,
  uploadDataset,
} from '#/server/fns/datasets.ts'

const datasetsQuery = queryOptions({ queryKey: ['datasets'], queryFn: () => listDatasets() })
const rowsQuery = (slug: string) =>
  queryOptions({
    queryKey: ['dataset-rows', slug],
    queryFn: () => getDatasetRows({ data: { slug } }),
    staleTime: Number.POSITIVE_INFINITY,
  })

export const Route = createFileRoute('/_app/datasets')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(datasetsQuery),
  component: DatasetsPage,
})

const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`
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

function DatasetsPage() {
  const qc = useQueryClient()
  const { data } = useQuery(datasetsQuery)
  const [open, setOpen] = useState<DatasetSummary | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['datasets'] })
  const toggle = useMutation({
    mutationFn: (m: LearnedModelSummary) =>
      setModelEnabled({ data: { id: m.id, enabled: !m.enabled } }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteModel({ data: { id } }),
    onSuccess: refresh,
  })
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

  const datasets = data?.datasets ?? []
  const models = data?.models ?? []
  const datasetName = (slug: string) => datasets.find((d) => d.slug === slug)?.name ?? slug

  return (
    <>
      <PageHeader
        title="Datasets"
        description="Labelled attack and benign requests. Train a model on a dataset, then use it in a workflow with the Learned rules block."
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
            <Button
              variant="primary"
              disabled={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              <Upload /> {upload.isPending ? 'Uploading…' : 'Upload dataset'}
            </Button>
          </>
        }
      />
      {uploadError ? (
        <div className="mb-4">
          <FormError message={uploadError} />
        </div>
      ) : null}

      <Card className="mb-5">
        <CardHeader
          title="Trained models"
          description="Enabled models are scored by every Learned rules block within about 30 seconds."
        />
        {models.length === 0 ? (
          <EmptyState
            title="No models yet"
            description="Open a dataset below and train one. Training runs in this browser and takes a few seconds."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Model</TH>
                <TH>Trained on</TH>
                <TH>Held-out attacks caught</TH>
                <TH>Held-out benign flagged</TH>
                <TH>Trained</TH>
                <TH>Enabled</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {models.map((m) => (
                <TR key={m.id}>
                  <TD className="text-xs font-medium">{m.name}</TD>
                  <TD className="text-xs text-muted">{datasetName(m.dataset)}</TD>
                  <TD className="font-mono text-xs">
                    {percent(m.metrics.recall)}{' '}
                    <span className="text-subtle">of {num(m.metrics.heldOutAttacks)}</span>
                  </TD>
                  <TD className="font-mono text-xs">
                    <span className={m.metrics.falsePositiveRate > 0.02 ? 'text-warn' : ''}>
                      {percent(m.metrics.falsePositiveRate)}
                    </span>{' '}
                    <span className="text-subtle">of {num(m.metrics.heldOutBenign)}</span>
                  </TD>
                  <TD className="text-xs text-muted">{timeAgo(m.trainedAt)}</TD>
                  <TD>
                    <Switch
                      checked={m.enabled}
                      onCheckedChange={() => toggle.mutate(m)}
                      label="Enabled"
                    />
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${m.name}`}
                      onClick={() => remove.mutate(m.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        {datasets.length === 0 ? (
          <EmptyState
            title="No datasets"
            description={
              <>
                Run <span className="font-mono">pnpm datasets:upload</span> to load the datasets
                shipped in the repository, or upload a JSON lines file with{' '}
                <span className="font-mono">text</span> and <span className="font-mono">label</span>{' '}
                fields.
              </>
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Dataset</TH>
                <TH>Contains</TH>
                <TH>Rows</TH>
                <TH>Attacks</TH>
                <TH>Benign</TH>
                <TH>Licence</TH>
                <TH>Models</TH>
              </tr>
            </THead>
            <TBody>
              {datasets.map((d) => (
                <TR key={d.slug} className="cursor-pointer" onClick={() => setOpen(d)}>
                  <TD className="text-xs font-medium">{d.name}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {Object.keys(d.byAttack).map((kind) => (
                        <Badge key={kind}>{label(kind)}</Badge>
                      ))}
                    </span>
                  </TD>
                  <TD className="font-mono text-xs">{num(d.rows)}</TD>
                  <TD className="font-mono text-xs">{num(d.attacks)}</TD>
                  <TD className="font-mono text-xs">{num(d.benign)}</TD>
                  <TD className="text-xs text-muted">{d.license || '—'}</TD>
                  <TD className="font-mono text-xs">
                    {models.filter((m) => m.dataset === d.slug).length || '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {open ? <DatasetSheet key={open.slug} dataset={open} onClose={() => setOpen(null)} /> : null}
    </>
  )
}

const stageLabel: Record<TrainProgress['stage'], string> = {
  features: 'Preparing features',
  training: 'Training',
  testing: 'Testing on held-out rows',
}

type Run =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'training'; progress: TrainProgress }
  | { phase: 'done'; result: TrainResult; seconds: number }
  | { phase: 'error'; message: string }

function DatasetSheet({ dataset, onClose }: { dataset: DatasetSummary; onClose: () => void }) {
  const qc = useQueryClient()
  const rows = useQuery(rowsQuery(dataset.slug))
  const [run, setRun] = useState<Run>({ phase: 'idle' })
  const [name, setName] = useState(dataset.name)

  const train = async () => {
    try {
      setRun({ phase: 'loading' })
      const all = await qc.ensureQueryData(rowsQuery(dataset.slug))
      const attacks = all.filter((r) => r.attack !== 'benign')
      const own = all.filter((r) => r.attack === 'benign')
      // Attacks alone cannot train a model: benign requests from the other datasets stand in
      // for normal traffic.
      const pool = await getBenignPool({
        data: {
          exclude: dataset.slug,
          limit: Math.min(6000, Math.max(1500, attacks.length * 2)),
        },
      })
      const examples: LabelledText[] = [
        ...attacks.map((r) => ({ text: r.text, attack: true })),
        ...own.map((r) => ({ text: r.text, attack: false })),
        ...pool.map((text) => ({ text, attack: false })),
      ]
      const started = performance.now()
      const result = await trainModel(examples, (progress) =>
        setRun({ phase: 'training', progress }),
      )
      setRun({ phase: 'done', result, seconds: (performance.now() - started) / 1000 })
    } catch (err) {
      setRun({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const save = useMutation({
    mutationFn: (result: TrainResult) =>
      saveModel({
        data: {
          name: name.trim() || dataset.name,
          dataset: dataset.slug,
          bias: result.bias,
          weights: encodeWeights(result.weights),
          attacks: result.attacks,
          benign: result.benign,
          metrics: result.metrics,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['datasets'] })
      onClose()
    },
  })

  const busy = run.phase === 'loading' || run.phase === 'training'
  const done = run.phase === 'training' ? run.progress.done : run.phase === 'done' ? 1 : 0

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

        <Card>
          <CardHeader
            title="Train a model"
            description="A logistic regression over character and word n-grams. It flags requests that look like the attacks in this dataset."
            actions={
              <Button variant="primary" disabled={busy || dataset.attacks === 0} onClick={train}>
                <BrainCircuit /> {run.phase === 'done' ? 'Train again' : 'Train'}
              </Button>
            }
          />
          <div className="flex flex-col gap-4 px-4 py-4">
            {dataset.attacks === 0 ? (
              <p className="text-xs text-muted">
                This dataset has no attack rows, so there is nothing to learn from it. Its rows are
                used as benign examples when other datasets are trained.
              </p>
            ) : run.phase === 'idle' ? (
              <p className="text-xs text-muted">
                Uses the {num(dataset.attacks)} attacks here, the benign rows here, and benign
                requests sampled from the other datasets. A fifth of the rows is held back for
                testing.
              </p>
            ) : null}

            {busy || run.phase === 'done' ? (
              <div>
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="font-medium">
                    {run.phase === 'loading'
                      ? 'Loading rows'
                      : run.phase === 'training'
                        ? stageLabel[run.progress.stage]
                        : `Trained in ${run.seconds.toFixed(1)} s`}
                  </span>
                  <span className="font-mono text-muted">
                    {run.phase === 'training' ? run.progress.detail : ''}
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-line"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(done * 100)}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-150"
                    style={{ width: `${Math.round(done * 100)}%` }}
                  />
                </div>
              </div>
            ) : null}

            {run.phase === 'error' ? <FormError message={run.message} /> : null}

            {run.phase === 'done' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Metric
                    label="Held-out attacks caught"
                    value={percent(run.result.metrics.recall)}
                    detail={`of ${num(run.result.metrics.heldOutAttacks)} it never saw`}
                    tone={run.result.metrics.recall >= 0.8 ? 'ok' : 'warn'}
                  />
                  <Metric
                    label="Held-out benign requests flagged"
                    value={percent(run.result.metrics.falsePositiveRate)}
                    detail={`of ${num(run.result.metrics.heldOutBenign)} it never saw`}
                    tone={run.result.metrics.falsePositiveRate <= 0.02 ? 'ok' : 'warn'}
                  />
                </div>
                <p className="text-xs text-muted">
                  The held-out rows come from the same datasets as the training rows, so these
                  numbers describe requests similar to this dataset. On traffic unlike it, expect
                  the model to catch less and to flag more.
                </p>
                <Field label="Model name">
                  <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
                </Field>
                <FormError message={save.error?.message ?? null} />
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    disabled={save.isPending}
                    onClick={() => save.mutate(run.result)}
                  >
                    Save and enable
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </Card>

        <div>
          <div className="mb-2 text-xs font-medium">Sample rows</div>
          {rows.isPending ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {(rows.data ?? []).slice(0, 8).map((row, i) => (
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

function Metric({
  label: title,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'ok' | 'warn'
}) {
  return (
    <div className="rounded-md border border-line px-3 py-2.5">
      <div className="text-[11px] text-muted">{title}</div>
      <div
        className={`mt-1 font-mono text-xl font-semibold ${tone === 'ok' ? 'text-ok' : 'text-warn'}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-subtle">{detail}</div>
    </div>
  )
}
