import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { createFileRoute } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
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

function DatasetsPage() {
  const qc = useQueryClient()
  const { data } = useQuery(datasetsQuery)
  const [open, setOpen] = useState<DatasetSummary | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
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

  const datasets = data?.datasets ?? []
  const models = data?.models ?? []

  return (
    <>
      <PageHeader
        title="Datasets"
        description="Labelled attack and benign requests for training. Add a Trained model step to a workflow and pick datasets there. To replay traffic against your workflows, use Attack analysis."
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
                <TH>Used by models</TH>
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
                    {models.filter((m) => m.datasets.includes(d.slug)).length || '—'}
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
            ? 'To block requests like these, add a Trained model step to a workflow and tick this dataset there.'
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
