import {
  type CheckConfig,
  encodeWeights,
  type LabelledText,
  selectionModelId,
  type TrainProgress,
  trainModel,
} from '@acl/shared'
import { Button, Field } from '@acl/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { datasetRowsQuery, datasetsQuery } from '#/lib/datasets.ts'
import { num, timeAgo } from '#/lib/format.ts'
import { getBenignPool, saveModel } from '#/server/fns/datasets.ts'

type LearnedCheck = Extract<CheckConfig, { type: 'learned' }>

const stageLabel: Record<TrainProgress['stage'], string> = {
  features: 'Preparing features',
  training: 'Training',
  testing: 'Testing on held-out rows',
}

const percent = (share: number) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`

type Run =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'training'; progress: TrainProgress }
  | { phase: 'error'; message: string }

/**
 * Picks the datasets a Trained model step is trained on and trains the model for that
 * selection in the browser. A selection that was trained before reuses its saved model.
 */
export function LearnedForm({
  check,
  onChange,
}: {
  check: LearnedCheck
  onChange: (patch: Partial<LearnedCheck>) => void
}) {
  const qc = useQueryClient()
  const { data, isPending } = useQuery(datasetsQuery)
  const [run, setRun] = useState<Run>({ phase: 'idle' })

  const trainable = (data?.datasets ?? []).filter((d) => d.attacks > 0)
  const selected = trainable.filter((d) => check.datasets.includes(d.slug))
  const modelId = selected.length ? selectionModelId(selected) : null
  const model = (data?.models ?? []).find((m) => m.id === modelId) ?? null
  const busy = run.phase === 'loading' || run.phase === 'training'

  const select = (slugs: string[]) => {
    const next = trainable.filter((d) => slugs.includes(d.slug))
    const id = next.length ? selectionModelId(next) : null
    const cached = (data?.models ?? []).some((m) => m.id === id)
    // The block only runs with a model for exactly this selection.
    onChange({ datasets: next.map((d) => d.slug), models: cached && id ? [id] : [] })
  }

  const train = async () => {
    if (!modelId) return
    try {
      setRun({ phase: 'loading' })
      const slugs = selected.map((d) => d.slug)
      const rows = (
        await Promise.all(slugs.map((slug) => qc.ensureQueryData(datasetRowsQuery(slug))))
      ).flat()
      const attacks = rows.filter((r) => r.attack !== 'benign')
      // Attacks alone cannot train a model: benign requests from the datasets that are not
      // selected stand in for normal traffic.
      const pool = await getBenignPool({
        data: { exclude: slugs, limit: Math.min(6000, Math.max(1500, attacks.length * 2)) },
      })
      const examples: LabelledText[] = [
        ...rows.map((r) => ({ text: r.text, attack: r.attack !== 'benign' })),
        ...pool.map((text) => ({ text, attack: false })),
      ]
      const result = await trainModel(examples, (progress) =>
        setRun({ phase: 'training', progress }),
      )
      await saveModel({
        data: {
          id: modelId,
          name: selected
            .map((d) => d.name)
            .join(', ')
            .slice(0, 120),
          datasets: slugs,
          bias: result.bias,
          weights: encodeWeights(result.weights),
          attacks: result.attacks,
          benign: result.benign,
          metrics: result.metrics,
        },
      })
      await qc.invalidateQueries({ queryKey: ['datasets'] })
      onChange({ models: [modelId] })
      setRun({ phase: 'idle' })
    } catch (err) {
      setRun({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (isPending) return <p className="text-xs text-muted">Loading datasets…</p>
  if (trainable.length === 0)
    return (
      <p className="text-xs text-muted">
        No datasets with attacks yet. Run <span className="font-mono">pnpm datasets:upload</span> or
        upload one on the Attack analysis page.
      </p>
    )

  return (
    <>
      <Field group label="Datasets" hint="The model learns the attacks in every dataset you tick.">
        <div className="flex max-h-56 min-w-0 flex-col gap-1.5 overflow-x-hidden overflow-y-auto rounded-md border border-line p-2.5">
          {trainable.map((d) => (
            <label key={d.slug} className="flex min-w-0 items-center gap-2 text-xs text-fg">
              <input
                type="checkbox"
                className="accent-[var(--color-accent)]"
                disabled={busy}
                checked={check.datasets.includes(d.slug)}
                onChange={(e) =>
                  select(
                    e.target.checked
                      ? [...check.datasets, d.slug]
                      : check.datasets.filter((s) => s !== d.slug),
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="font-mono text-[11px] text-subtle">{num(d.attacks)}</span>
            </label>
          ))}
        </div>
      </Field>

      <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
        <div className="flex flex-col gap-3">
          <div className="min-w-0 text-xs">
            {selected.length === 0 ? (
              <span className="text-muted">Pick at least one dataset.</span>
            ) : model ? (
              <>
                <div className="font-medium text-ok">Trained {timeAgo(model.trainedAt)}</div>
                <div className="mt-0.5 text-muted">
                  Caught {percent(model.metrics.recall)} of {num(model.metrics.heldOutAttacks)}{' '}
                  held-out attacks, flagged{' '}
                  <span className={model.metrics.falsePositiveRate > 0.02 ? 'text-warn' : ''}>
                    {percent(model.metrics.falsePositiveRate)}
                  </span>{' '}
                  of {num(model.metrics.heldOutBenign)} held-out benign requests.
                </div>
              </>
            ) : (
              <span className="text-warn">
                Not trained for this selection. The step passes everything until it is.
              </span>
            )}
          </div>
          <Button
            className="self-start"
            variant={model ? 'ghost' : 'primary'}
            disabled={busy || selected.length === 0}
            onClick={train}
          >
            <BrainCircuit /> {model ? 'Train again' : 'Train'}
          </Button>
        </div>

        {busy ? (
          <div>
            <div className="mb-1.5 flex justify-between text-xs">
              <span className="font-medium">
                {run.phase === 'training' ? stageLabel[run.progress.stage] : 'Loading rows'}
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
              aria-valuenow={run.phase === 'training' ? Math.round(run.progress.done * 100) : 0}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{
                  width: `${run.phase === 'training' ? Math.round(run.progress.done * 100) : 2}%`,
                }}
              />
            </div>
          </div>
        ) : null}
        {run.phase === 'error' ? <FormError message={run.message} /> : null}
        {model ? (
          <p className="text-[11px] text-subtle">
            Held-out rows come from the same datasets as the training rows. On traffic unlike them,
            expect the model to catch less and to flag more.
          </p>
        ) : null}
      </div>
    </>
  )
}
