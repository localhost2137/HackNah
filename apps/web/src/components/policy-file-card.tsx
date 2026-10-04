import type { PolicyChange } from '@acl/shared'
import { Badge, Button, Card, CardHeader, Select, Textarea } from '@acl/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { exportPolicy, importPolicy } from '#/server/fns/policy.ts'

const actionTone = {
  create: 'ok',
  update: 'accent',
  disable: 'warn',
  unchanged: 'neutral',
} as const

/**
 * Exports the instance's guardrails, limits and model catalog as one documented YAML file, and
 * applies one: preview the changes first, then apply.
 */
export function PolicyFileCard() {
  const qc = useQueryClient()
  const [yaml, setYaml] = useState('')
  const [mode, setMode] = useState<'replace' | 'merge'>('replace')
  const [preview, setPreview] = useState<PolicyChange[] | null>(null)

  const download = useMutation({
    mutationFn: () => exportPolicy(),
    onSuccess: (text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }))
      const a = document.createElement('a')
      a.href = url
      a.download = 'acl-policy.yaml'
      a.click()
      URL.revokeObjectURL(url)
    },
  })
  const run = useMutation({
    mutationFn: (dryRun: boolean) => importPolicy({ data: { yaml, mode, dryRun } }),
    onSuccess: async (result, dryRun) => {
      if (!result.ok) return setPreview(null)
      setPreview(result.changes)
      if (!dryRun) {
        await qc.invalidateQueries()
      }
    },
  })
  const errors = run.data && !run.data.ok ? run.data.errors : null
  const applied = run.data?.ok && run.data.applied
  const pending = (preview ?? []).filter((c) => c.action !== 'unchanged')

  return (
    <Card>
      <CardHeader
        title="Policy file"
        actions={
          <Button size="sm" disabled={download.isPending} onClick={() => download.mutate()}>
            <Download /> Export
          </Button>
        }
      />
      <div className="flex flex-col gap-4 p-5 text-[13px]">
        <p className="text-muted leading-relaxed">
          Export or import guardrails, limits, and models in a YAML file. Preview changes before
          applying them. Applying publishes changed guardrails immediately.
        </p>
        <Textarea
          rows={8}
          aria-label="Policy YAML"
          className="font-mono text-xs"
          placeholder="Paste a policy file, or choose one below"
          value={yaml}
          onChange={(e) => {
            setYaml(e.target.value)
            setPreview(null)
            run.reset()
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted hover:text-fg">
            <Upload className="size-3.5" />
            Choose file
            <input
              type="file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setYaml(await file.text())
                setPreview(null)
                run.reset()
              }}
            />
          </label>
          <Select
            aria-label="Policy import mode"
            aria-describedby="policy-import-mode-hint"
            className="ml-auto w-full sm:w-64"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as 'replace' | 'merge')
              setPreview(null)
            }}
          >
            <option value="replace">Replace existing policy</option>
            <option value="merge">Merge with existing policy</option>
          </Select>
          <Button
            size="sm"
            disabled={!yaml.trim() || run.isPending}
            onClick={() => run.mutate(true)}
          >
            Preview
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!preview || applied || pending.length === 0 || run.isPending}
            onClick={() => run.mutate(false)}
          >
            Apply
          </Button>
        </div>
        <p id="policy-import-mode-hint" className="text-xs text-muted">
          {mode === 'replace'
            ? 'Replace disables configuration omitted from the file.'
            : 'Merge only adds and updates items; omitted configuration is kept.'}
        </p>
        <FormError message={run.error?.message ?? null} />
        {errors ? (
          <ul className="flex flex-col gap-1 rounded-md bg-bad-soft px-3 py-2 font-mono text-[11px] text-bad">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        {preview ? (
          <div className="flex flex-col gap-1">
            <span className="text-muted">
              {applied
                ? 'Applied.'
                : pending.length
                  ? `${pending.length} change${pending.length === 1 ? '' : 's'} to apply:`
                  : 'Nothing to change: the instance already matches this file.'}
            </span>
            <ul className="flex flex-col gap-1">
              {preview
                .filter((c) => c.action !== 'unchanged')
                .map((c) => (
                  <li key={`${c.kind}:${c.name}`} className="flex items-center gap-2">
                    <Badge tone={actionTone[c.action]}>{c.action}</Badge>
                    <span className="text-muted">{c.kind}</span>
                    <span className="font-medium">{c.name}</span>
                    {c.fields?.length ? (
                      <span className="text-subtle">{c.fields.join(', ')}</span>
                    ) : null}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
