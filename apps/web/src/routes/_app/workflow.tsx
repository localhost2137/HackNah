import {
  type StepType,
  stepLabels,
  type WorkflowDefinition,
  type WorkflowStep,
  workflowDefinition,
} from '@acl/shared'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  cn,
  Dialog,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
} from '@acl/ui'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FormError } from '#/components/auth-shell.tsx'
import { newStep, StepForm, stepSummary } from '#/components/workflow/step-form.tsx'
import { timeAgo } from '#/lib/format.ts'
import { discardDraft, getWorkflow, publishDraft, saveDraft } from '#/server/fns/workflow.ts'

const workflowQuery = queryOptions({ queryKey: ['workflow'], queryFn: () => getWorkflow() })

export const Route = createFileRoute('/_app/workflow')({
  loader: ({ context }) => context.queryClient.ensureQueryData(workflowQuery),
  component: WorkflowPage,
})

const singleton: StepType[] = ['fingerprint', 'redact']

function WorkflowPage() {
  const { isAdmin } = Route.useRouteContext()
  const qc = useQueryClient()
  const { data } = useQuery(workflowQuery)
  const [def, setDef] = useState<WorkflowDefinition | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (data && !def) {
      setDef(data.working)
      setSelectedId(data.working.steps[0]?.id ?? null)
    }
  }, [data, def])

  const baseline = data?.draft?.definition ?? data?.published?.definition ?? data?.working
  const dirty = useMemo(() => JSON.stringify(def) !== JSON.stringify(baseline), [def, baseline])
  const validation = def ? workflowDefinition.safeParse(def) : null

  const refresh = () => qc.invalidateQueries({ queryKey: ['workflow'] })
  const save = useMutation({
    mutationFn: (d: WorkflowDefinition) => saveDraft({ data: { definition: d } }),
    onSuccess: refresh,
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty && def) await saveDraft({ data: { definition: def } })
      return publishDraft({ data: { note: note || undefined } })
    },
    onSuccess: async () => {
      setPublishOpen(false)
      setNote('')
      await refresh()
    },
  })
  const discard = useMutation({
    mutationFn: () => discardDraft(),
    onSuccess: async () => {
      setDef(null)
      await refresh()
    },
  })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  if (!data || !def) return null

  const selected = def.steps.find((s) => s.id === selectedId) ?? null
  const updateStep = (step: WorkflowStep) =>
    setDef({ ...def, steps: def.steps.map((s) => (s.id === step.id ? step : s)) })
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = def.steps.findIndex((s) => s.id === e.active.id)
    const to = def.steps.findIndex((s) => s.id === e.over!.id)
    setDef({ ...def, steps: arrayMove(def.steps, from, to) })
  }
  const addStep = (type: StepType) => {
    const step = newStep(type)
    setDef({ ...def, steps: [...def.steps, step] })
    setSelectedId(step.id)
  }

  return (
    <>
      <PageHeader
        title="Workflow"
        description="One shared pipeline runs on every prompt and tool call, top to bottom. A blocking failure stops the pipeline; approvals wait for a human."
        actions={
          isAdmin ? (
            <>
              {data.draft ? (
                <Button
                  variant="ghost"
                  onClick={() => discard.mutate()}
                  disabled={discard.isPending}
                >
                  Discard draft
                </Button>
              ) : null}
              <Button
                onClick={() => save.mutate(def)}
                disabled={!dirty || !validation?.success || save.isPending}
              >
                Save draft
              </Button>
              <Button
                variant="primary"
                onClick={() => setPublishOpen(true)}
                disabled={!validation?.success || (!dirty && !data.draft)}
              >
                Publish
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-4 flex items-center gap-3 text-xs text-muted">
        <span>
          Live:{' '}
          {data.published ? (
            <Badge tone="ok">v{data.published.version}</Badge>
          ) : (
            <Badge tone="neutral">built-in default</Badge>
          )}
        </span>
        {data.draft ? <Badge tone="warn">Draft v{data.draft.version}</Badge> : null}
        {dirty ? <Badge tone="accent">Unsaved changes</Badge> : null}
        {validation && !validation.success ? (
          <span className="text-bad">
            {validation.error.issues[0]?.path.join('.')}: {validation.error.issues[0]?.message}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Request comes in" description="Prompt, tool result or tool call" />
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={def.steps.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                <ol className="flex flex-col gap-2 p-3">
                  {def.steps.map((step, i) => (
                    <SortableStep
                      key={step.id}
                      index={i}
                      step={step}
                      selected={step.id === selectedId}
                      disabled={!isAdmin}
                      onSelect={() => setSelectedId(step.id)}
                      onToggle={(enabled) => updateStep({ ...step, enabled })}
                      onRemove={() =>
                        setDef({ ...def, steps: def.steps.filter((s) => s.id !== step.id) })
                      }
                    />
                  ))}
                  {def.steps.length === 0 ? (
                    <li className="rounded-md border border-dashed border-line-strong p-4 text-center text-xs text-muted">
                      No checks: every request is allowed.
                    </li>
                  ) : null}
                </ol>
              </SortableContext>
            </DndContext>
            {isAdmin ? (
              <div className="flex items-center gap-2 border-t border-line px-3 py-2">
                <Plus className="size-3.5 text-muted" />
                <Select
                  className="h-7 w-48"
                  value=""
                  onChange={(e) => e.target.value && addStep(e.target.value as StepType)}
                >
                  <option value="">Add a check…</option>
                  {(Object.keys(stepLabels) as StepType[])
                    .filter((t) => !singleton.includes(t) || !def.steps.some((s) => s.type === t))
                    .map((t) => (
                      <option key={t} value={t}>
                        {stepLabels[t]}
                      </option>
                    ))}
                </Select>
              </div>
            ) : null}
          </Card>
          <Card className="px-4 py-3">
            <div className="text-[13px] font-semibold">Decision</div>
            <p className="mt-1 text-xs text-muted">
              Any blocking failure blocks. Otherwise any approval failure sends the request to the{' '}
              <span className="text-fg">Approvals</span> queue and holds it until someone decides or
              it times out. Otherwise it is allowed.
            </p>
            <Field label="Approval timeout (seconds)" className="mt-3 w-56">
              <Input
                type="number"
                min={10}
                max={3600}
                value={def.approvalTimeoutSec}
                disabled={!isAdmin}
                onChange={(e) => setDef({ ...def, approvalTimeoutSec: Number(e.target.value) })}
              />
            </Field>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            {selected ? (
              <>
                <CardHeader
                  title={stepLabels[selected.type]}
                  description={<span className="font-mono">{selected.id}</span>}
                />
                <fieldset disabled={!isAdmin} className="p-4">
                  <StepForm step={selected} onChange={updateStep} />
                </fieldset>
              </>
            ) : (
              <div className="p-6 text-xs text-muted">Select a step to configure it.</div>
            )}
          </Card>
          <Card>
            <CardHeader title="Version history" />
            <ul className="divide-y divide-line">
              {data.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                  <span className="w-8 font-mono">v{v.version}</span>
                  <Badge
                    tone={
                      v.status === 'published'
                        ? v.id === data.published?.id
                          ? 'ok'
                          : 'neutral'
                        : 'warn'
                    }
                  >
                    {v.id === data.published?.id ? 'live' : v.status}
                  </Badge>
                  <span className="flex-1 truncate text-muted">{v.note ?? ''}</span>
                  <span className="text-subtle">
                    {v.createdBy} · {timeAgo(v.createdAt)}
                  </span>
                  {isAdmin ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDef(workflowDefinition.parse(v.definition))}
                    >
                      Load
                    </Button>
                  ) : null}
                </li>
              ))}
              {data.versions.length === 0 ? (
                <li className="px-4 py-3 text-xs text-muted">
                  Nothing published yet; the built-in default is active.
                </li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>

      <Dialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title="Publish workflow"
        description="Gateways pick up the new version within about 10 seconds."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => publish.mutate()} disabled={publish.isPending}>
              Publish
            </Button>
          </>
        }
      >
        <Field label="What changed?">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Block curl | sh in tool calls"
          />
        </Field>
        <div className="mt-3">
          <FormError message={publish.error?.message ?? null} />
        </div>
      </Dialog>
    </>
  )
}

function SortableStep({
  step,
  index,
  selected,
  disabled,
  onSelect,
  onToggle,
  onRemove,
}: {
  step: WorkflowStep
  index: number
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
    disabled,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-panel-2 px-2 py-2',
        selected ? 'border-accent' : 'border-line',
        isDragging && 'z-10 shadow-lg',
        !step.enabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        className="cursor-grab text-subtle hover:text-fg"
        aria-label="Reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <span className="w-4 text-center font-mono text-[11px] text-subtle">{index + 1}</span>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="text-[13px] font-medium">{stepLabels[step.type]}</div>
        <div className="truncate text-[11px] text-muted">{stepSummary(step)}</div>
      </button>
      <Switch
        checked={step.enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        label="Enabled"
      />
      {!disabled ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-subtle hover:text-bad"
          aria-label="Remove step"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </li>
  )
}
