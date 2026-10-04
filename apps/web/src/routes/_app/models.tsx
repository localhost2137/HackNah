import { formatAmount, type ModelEntry } from '@acl/shared'
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
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { deleteModel, listModels, reorderModels, saveModel } from '#/server/fns/models.ts'

const modelsQuery = queryOptions({ queryKey: ['models'], queryFn: () => listModels() })

export const Route = createFileRoute('/_app/models')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(modelsQuery),
  component: ModelsPage,
})

type Draft = Omit<ModelEntry, 'id'> & { id?: string; apiKey?: string | null; hasApiKey?: boolean }

const blank: Draft = {
  pattern: '',
  label: '',
  kind: 'external',
  apiFormat: 'anthropic',
  baseUrl: '',
  upstreamModel: '',
  inputUsdPerMTok: 0,
  outputUsdPerMTok: 0,
  cacheWriteUsdPerMTok: 0,
  cacheReadUsdPerMTok: 0,
  gpuUsdPerHour: 0,
  enabled: true,
}

/**
 * Starting points. Prices are list prices per million tokens when this was written (cache
 * write = 5-minute cache); check them against your provider before relying on them.
 */
const presets: { label: string; draft: Draft }[] = [
  {
    label: 'Claude Sonnet 4.5',
    draft: {
      ...blank,
      pattern: 'claude-sonnet-4-5*',
      label: 'Claude Sonnet 4.5',
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheWriteUsdPerMTok: 3.75,
      cacheReadUsdPerMTok: 0.3,
    },
  },
  {
    label: 'Claude Haiku 4.5',
    draft: {
      ...blank,
      pattern: 'claude-haiku-4-5*',
      label: 'Claude Haiku 4.5',
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cacheWriteUsdPerMTok: 1.25,
      cacheReadUsdPerMTok: 0.1,
    },
  },
  {
    label: 'Claude Opus 4.5',
    draft: {
      ...blank,
      pattern: 'claude-opus-4-5*',
      label: 'Claude Opus 4.5',
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheWriteUsdPerMTok: 6.25,
      cacheReadUsdPerMTok: 0.5,
    },
  },
  {
    label: 'Any model on OpenRouter (OpenAI API)',
    draft: {
      ...blank,
      pattern: 'openai/gpt-*',
      label: 'GPT via OpenRouter',
      apiFormat: 'openai',
    },
  },
  {
    label: 'Local model (Ollama)',
    draft: {
      ...blank,
      pattern: 'qwen3-coder*',
      label: 'Qwen3 Coder (local)',
      kind: 'local',
      apiFormat: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      gpuUsdPerHour: 1.5,
    },
  },
]

const price = (n: number) => formatAmount('cost', n)

function ModelsPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data: models = [] } = useQuery(modelsQuery)
  const [draft, setDraft] = useState<Draft | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['models'] })
  const save = useMutation({
    mutationFn: ({ hasApiKey: _, ...d }: Draft) => saveModel({ data: d }),
    onSuccess: async () => {
      setDraft(null)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteModel({ data: { id } }),
    onSuccess: invalidate,
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderModels({ data: { ids } }),
    onSuccess: invalidate,
  })
  const move = (index: number, by: number) => {
    const ids = models.map((m) => m.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id!)
    reorder.mutate(ids)
  }

  return (
    <>
      <PageHeader
        title="Models"
        description="Manage the models your team can use, where they run, and what they cost."
        details="Where each model is served and what it costs. Requests are routed to the first entry whose pattern matches the model; with entries here, models outside the catalog are refused. Groups choose from these models, and Limits price usage with them."
        actions={
          isAdmin ? (
            <div className="flex gap-2">
              <Select
                className="w-48"
                value=""
                onChange={(e) => {
                  const preset = presets.find((p) => p.label === e.target.value)
                  if (preset) setDraft({ ...preset.draft })
                }}
              >
                <option value="">Add from a preset…</option>
                {presets.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <Button variant="primary" onClick={() => setDraft({ ...blank })}>
                <Plus /> New model
              </Button>
            </div>
          ) : null
        }
      />
      <Card>
        {models.length === 0 ? (
          <EmptyState
            title="No models in the catalog"
            description="Every model request goes to the default upstream and costs are not tracked. Add Claude models with their prices, or a local model served by Ollama or vLLM."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                {isAdmin ? <TH className="w-16">Order</TH> : null}
                <TH>Model</TH>
                <TH>Served by</TH>
                <TH>Price</TH>
                <TH>Enabled</TH>
                {isAdmin ? <TH /> : null}
              </tr>
            </THead>
            <TBody>
              {models.map((m, i) => (
                <TR key={m.id}>
                  {isAdmin ? (
                    <TD>
                      <div className="flex">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          aria-label="Move up"
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={i === models.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label="Move down"
                        >
                          <ArrowDown />
                        </Button>
                      </div>
                    </TD>
                  ) : null}
                  <TD className="text-xs">
                    {m.label ? <div className="font-medium">{m.label}</div> : null}
                    <span className="font-mono text-muted">{m.pattern}</span>
                    {m.upstreamModel ? (
                      <span className="font-mono text-subtle"> → {m.upstreamModel}</span>
                    ) : null}
                  </TD>
                  <TD className="text-xs">
                    <Badge tone={m.kind === 'local' ? 'accent' : 'neutral'} className="mr-2">
                      {m.kind}
                    </Badge>
                    <Badge className="mr-2">{m.apiFormat}</Badge>
                    <span className="font-mono text-muted">{m.baseUrl || 'default upstream'}</span>
                  </TD>
                  <TD className="font-mono text-xs text-muted">
                    {m.kind === 'local'
                      ? `${price(m.gpuUsdPerHour)} / GPU-h`
                      : `${price(m.inputUsdPerMTok)} in · ${price(m.outputUsdPerMTok)} out · ${price(m.cacheReadUsdPerMTok)} cache read / Mtok`}
                  </TD>
                  <TD>
                    <Switch
                      checked={m.enabled}
                      disabled={!isAdmin}
                      onCheckedChange={(enabled) =>
                        save.mutate({ ...m, enabled, apiKey: undefined })
                      }
                      label="Enabled"
                    />
                  </TD>
                  {isAdmin ? (
                    <TD className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setDraft({ ...m })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>
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
        title={draft?.id ? 'Edit model' : 'New model'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !draft?.pattern}
              onClick={() => draft && save.mutate(draft)}
            >
              Save
            </Button>
          </>
        }
      >
        {draft ? <ModelForm draft={draft} onChange={setDraft} error={save.error} /> : null}
      </Sheet>
    </>
  )
}

function ModelForm({
  draft,
  onChange,
  error,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  error: Error | null
}) {
  const num = (key: keyof Draft, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={0}
        step={0.01}
        value={Number(draft[key] ?? 0)}
        onChange={(e) => onChange({ ...draft, [key]: Number(e.target.value) })}
      />
    </Field>
  )
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Model id pattern"
        hint="Glob over the model id the client asks for. Concrete ids are also offered to Claude Code's model picker."
      >
        <Input
          className="font-mono"
          value={draft.pattern}
          placeholder="claude-sonnet-4-5*"
          onChange={(e) => onChange({ ...draft, pattern: e.target.value })}
        />
      </Field>
      <Field label="Name">
        <Input
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
        />
      </Field>
      <Field label="Type">
        <Select
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as Draft['kind'] })}
        >
          <option value="external">External API: priced per token</option>
          <option value="local">Local model: priced per GPU time</option>
        </Select>
      </Field>
      <Field
        label="API format"
        hint="Claude Code always talks Anthropic to the gateway; an OpenAI-compatible upstream is translated both ways. Thinking blocks and cache markers don't survive the translation."
      >
        <Select
          value={draft.apiFormat}
          onChange={(e) => onChange({ ...draft, apiFormat: e.target.value as Draft['apiFormat'] })}
        >
          <option value="anthropic">
            Anthropic Messages (OpenRouter, Anthropic, Ollama ≥ 0.14)
          </option>
          <option value="openai">
            OpenAI chat completions (OpenRouter, Ollama, vLLM, LM Studio, llama.cpp)
          </option>
        </Select>
      </Field>
      <Field
        label="Base URL"
        hint={
          draft.apiFormat === 'openai'
            ? 'The gateway appends /chat/completions, so this usually ends in /v1. Empty uses OpenRouter.'
            : 'The gateway appends /v1/messages. Empty uses the default upstream (OpenRouter).'
        }
      >
        <Input
          className="font-mono"
          value={draft.baseUrl}
          placeholder={
            draft.apiFormat === 'openai' ? 'http://localhost:11434/v1' : 'default upstream'
          }
          onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
        />
      </Field>
      <Field label="Upstream model id" hint="Sent upstream instead of the requested id. Optional.">
        <Input
          className="font-mono"
          value={draft.upstreamModel}
          onChange={(e) => onChange({ ...draft, upstreamModel: e.target.value })}
        />
      </Field>
      <Field
        label="API key"
        hint={
          draft.hasApiKey
            ? 'A key is stored. Leave empty to keep it.'
            : 'Encrypted at rest. Empty: no key for a custom base URL, the gateway key for the default upstream.'
        }
      >
        <Input
          type="password"
          autoComplete="off"
          value={draft.apiKey ?? ''}
          onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
        />
      </Field>
      {draft.kind === 'external' ? (
        <div className="grid grid-cols-2 gap-4">
          {num('inputUsdPerMTok', 'Input $ / Mtok')}
          {num('outputUsdPerMTok', 'Output $ / Mtok')}
          {num('cacheWriteUsdPerMTok', 'Cache write $ / Mtok')}
          {num('cacheReadUsdPerMTok', 'Cache read $ / Mtok')}
        </div>
      ) : (
        num(
          'gpuUsdPerHour',
          '$ per GPU-hour',
          'What the GPU costs while it serves this model, so local usage can share a USD budget with API models. GPU time is counted either way.',
        )
      )}
      <FormError message={error?.message ?? null} />
    </div>
  )
}
