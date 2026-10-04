import { Badge, Button, Dialog, Field, Input, Select } from '@acl/ui'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { importHuggingFace, inspectHuggingFace } from '#/server/fns/datasets.ts'

type Inspection = Awaited<ReturnType<typeof inspectHuggingFace>>
type AttackLabel = 'prompt_injection' | 'jailbreak' | 'indirect_injection' | 'custom'

const NO_LABEL_ATTACKS = '__all_attacks__'
const NO_LABEL_NORMAL = '__all_normal__'

/**
 * Adds a public Hugging Face dataset: look it up, say which column is the text and which label
 * values mean "attack", then import the rows.
 */
export function HuggingFaceImport({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => Promise<unknown>
}) {
  const [name, setName] = useState('')
  const [found, setFound] = useState<Inspection | null>(null)
  const [split, setSplit] = useState(0)
  const [textColumn, setTextColumn] = useState('')
  const [labelColumn, setLabelColumn] = useState(NO_LABEL_ATTACKS)
  const [attackValues, setAttackValues] = useState<string[]>([])
  const [attackLabel, setAttackLabel] = useState<AttackLabel>('prompt_injection')
  const [limit, setLimit] = useState(1000)

  const lookUp = useMutation({
    mutationFn: () => inspectHuggingFace({ data: { dataset: name } }),
    onSuccess: (result) => {
      setFound(result)
      setSplit(0)
      setTextColumn(result.guess.textColumn)
      setLabelColumn(result.guess.labelColumn ?? NO_LABEL_ATTACKS)
      setAttackValues(result.guess.attackValues)
    },
  })
  const hasLabel = labelColumn !== NO_LABEL_ATTACKS && labelColumn !== NO_LABEL_NORMAL
  const add = useMutation({
    mutationFn: () => {
      const chosen = found!.splits[split]!
      return importHuggingFace({
        data: {
          dataset: found!.dataset,
          config: chosen.config,
          split: chosen.split,
          textColumn,
          labelColumn: hasLabel ? labelColumn : null,
          attackValues,
          allAttacks: labelColumn === NO_LABEL_ATTACKS,
          attackLabel,
          limit,
          license: found!.license,
        },
      })
    },
    onSuccess: async () => {
      await onImported()
      close()
    },
  })
  const close = () => {
    setFound(null)
    setName('')
    lookUp.reset()
    add.reset()
    onClose()
  }

  // The distinct values of the chosen label column in the sample, to tick as "attack".
  const values =
    hasLabel && found ? [...new Set(found.sample.map((r) => r[labelColumn] ?? ''))] : []
  const chosenSplit = found?.splits[split]
  const preview = found?.sample.slice(0, 4) ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Add a dataset from Hugging Face"
      description="Works with public datasets that have the dataset viewer on. Gated datasets need an account and cannot be read."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {found ? (
            <Button
              variant="primary"
              disabled={add.isPending || !textColumn || (hasLabel && attackValues.length === 0)}
              onClick={() => add.mutate()}
            >
              {add.isPending
                ? 'Importing…'
                : `Import ${Math.min(limit, chosenSplit?.rows ?? limit).toLocaleString()} rows`}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={lookUp.isPending || !name.trim()}
              onClick={() => lookUp.mutate()}
            >
              {lookUp.isPending ? 'Looking up…' : 'Look up'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Dataset" hint="owner/name, or the link to its Hugging Face page.">
          <Input
            value={name}
            placeholder="deepset/prompt-injections"
            disabled={found !== null}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !found && name.trim()) lookUp.mutate()
            }}
          />
        </Field>
        <FormError message={lookUp.error?.message ?? add.error?.message ?? null} />

        {found ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Split">
                <Select value={split} onChange={(e) => setSplit(Number(e.target.value))}>
                  {found.splits.map((s, i) => (
                    <option key={`${s.config}/${s.split}`} value={i}>
                      {s.config === 'default' ? s.split : `${s.config} / ${s.split}`} ·{' '}
                      {s.rows.toLocaleString()} rows
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rows to import" hint="Larger splits are sampled evenly.">
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                  {[200, 500, 1000, 2000].map((n) => (
                    <option key={n} value={n}>
                      up to {n.toLocaleString()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Text column">
                <Select value={textColumn} onChange={(e) => setTextColumn(e.target.value)}>
                  {found.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Label column">
                <Select
                  value={labelColumn}
                  onChange={(e) => {
                    setLabelColumn(e.target.value)
                    setAttackValues([])
                  }}
                >
                  {found.columns
                    .filter((c) => c.name !== textColumn)
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  <option value={NO_LABEL_ATTACKS}>No label: every row is an attack</option>
                  <option value={NO_LABEL_NORMAL}>No label: every row is normal</option>
                </Select>
              </Field>
            </div>

            {hasLabel ? (
              <Field
                group
                label="Which values mean attack?"
                hint="Rows with any other value are imported as normal requests. Values come from the first rows of the split."
              >
                <div className="flex flex-wrap gap-1.5">
                  {values.map((v) => {
                    const on = attackValues.includes(v)
                    return (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setAttackValues(
                            on ? attackValues.filter((x) => x !== v) : [...attackValues, v],
                          )
                        }
                      >
                        <Badge tone={on ? 'bad' : 'neutral'} className="font-mono">
                          {v || '(empty)'}
                        </Badge>
                      </button>
                    )
                  })}
                </div>
              </Field>
            ) : null}

            {labelColumn !== NO_LABEL_NORMAL ? (
              <Field label="Kind of attack">
                <Select
                  value={attackLabel}
                  onChange={(e) => setAttackLabel(e.target.value as AttackLabel)}
                >
                  <option value="prompt_injection">Prompt injection</option>
                  <option value="jailbreak">Jailbreak</option>
                  <option value="indirect_injection">Indirect injection</option>
                  <option value="custom">Other</option>
                </Select>
              </Field>
            ) : null}

            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">First rows</div>
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                {preview.map((row, i) => {
                  const attack = hasLabel
                    ? attackValues.includes(row[labelColumn] ?? '')
                    : labelColumn === NO_LABEL_ATTACKS
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sample rows have no identity
                    <li key={i} className="flex items-start gap-2 px-3 py-2">
                      <Badge tone={attack ? 'bad' : 'ok'}>{attack ? 'attack' : 'normal'}</Badge>
                      <span className="line-clamp-2 min-w-0 flex-1 font-mono text-[11px] break-words text-muted">
                        {row[textColumn]}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-1.5 text-[11px] text-subtle">Licence: {found.license}</p>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
