import type { BlockId, Condition, ConditionNode, GraphIssue, PolicyNode } from '@acl/shared'
import { blockOf, blocks, eventKind, inputLabels, kindLabels, palette } from '@acl/shared'
import { Button, Field, Input, Select, Switch } from '@acl/ui'
import { Trash2 } from 'lucide-react'
import { toneColor } from './graph-nodes.tsx'
import { LearnedForm } from './learned-form.tsx'
import { CheckboxGroup, FieldForm } from './step-form.tsx'

export type Option = { value: string; label: string }
export type PickerOptions = {
  servers: Option[]
  resources: Option[]
  groups: Option[]
  /** Limits a Limit block can read. */
  limits?: Option[]
}

const kinds: Option[] = eventKind.options.map((value) => ({ value, label: kindLabels[value] }))

const sources: Option[] = [
  { value: 'mcp', label: 'MCP server' },
  { value: 'builtin', label: 'Built-in (Bash, Edit, …)' },
]

const deviceStatuses: Option[] = [
  { value: 'trusted', label: 'Trusted' },
  { value: 'new', label: 'New' },
  { value: 'mismatch', label: 'Mismatch' },
]

const tiers: Option[] = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'destructive', label: 'Destructive' },
]

const keyStorages: Option[] = [
  { value: 'secure_enclave', label: 'Secure Enclave' },
  { value: 'tpm', label: 'TPM' },
  { value: 'software', label: 'Software key' },
]

export function Inspector({
  node,
  issues,
  options,
  readOnly,
  onChange,
  onDelete,
}: {
  node: PolicyNode
  issues: GraphIssue[]
  options: PickerOptions
  readOnly: boolean
  onChange: (node: PolicyNode) => void
  onDelete: () => void
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{blockOf(node).label}</div>
          <div className="font-mono text-[11px] text-subtle">{node.id}</div>
        </div>
        {!readOnly && node.type !== 'trigger' ? (
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete node">
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1 border-b border-line px-4 py-2 text-xs">
          {issues.map((i) => (
            <li key={i.message} className={i.level === 'error' ? 'text-bad' : 'text-warn'}>
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4 p-4">
        <NodeForm node={node} options={options} onChange={onChange} />
      </fieldset>
    </div>
  )
}

function NodeForm({
  node,
  options,
  onChange,
}: {
  node: PolicyNode
  options: PickerOptions
  onChange: (node: PolicyNode) => void
}) {
  const block = blockOf(node)
  return (
    <>
      <div className="flex flex-col gap-1.5 text-xs">
        <p className="text-fg">{block.description}</p>
        {block.details ? <p className="text-muted">{block.details}</p> : null}
        {block.source !== '—' ? (
          <p className="text-muted">
            <span className="text-subtle">Data from:</span> {block.source}
          </p>
        ) : null}
      </div>
      {node.type === 'check' ? (
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={node.enabled}
            onCheckedChange={(enabled) => onChange({ ...node, enabled })}
          />
          Enabled
        </label>
      ) : null}
      {node.type === 'condition' ? (
        <ConditionForm node={node} options={options} onChange={onChange} />
      ) : node.type === 'check' ? (
        <>
          {node.check.type === 'learned' ? (
            <LearnedForm
              check={node.check}
              onChange={(patch) =>
                onChange({ ...node, check: { ...node.check, ...patch } } as PolicyNode)
              }
            />
          ) : null}
          <FieldForm
            fields={block.fields}
            value={node.check}
            limits={options.limits}
            onChange={(patch) =>
              onChange({ ...node, check: { ...node.check, ...patch } } as PolicyNode)
            }
          />
        </>
      ) : (
        <>
          {node.type === 'decision' ? (
            <Field label="Outcome">
              <Select
                value={block.id}
                onChange={(e) =>
                  onChange({
                    ...node,
                    ...blocks[e.target.value as BlockId].create(),
                    reason: node.reason,
                  } as PolicyNode)
                }
              >
                {palette
                  .filter((b) => b.nodeType === 'decision')
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
          <FieldForm
            fields={block.fields}
            value={node}
            onChange={(patch) => onChange({ ...node, ...patch } as PolicyNode)}
          />
        </>
      )}
      <BlockInterface node={node} />
    </>
  )
}

/** What the block reads, and where each output usually leads. */
function BlockInterface({ node }: { node: PolicyNode }) {
  const block = blockOf(node)
  if (block.inputs.length === 0 && block.outputs.length === 0) return null
  return (
    <dl className="flex flex-col gap-3 border-t border-line pt-4 text-xs">
      {block.inputs.length > 0 ? (
        <div>
          <dt className="mb-1 font-medium text-fg">Reads</dt>
          <dd className="text-muted">{block.inputs.map((i) => inputLabels[i]).join(' · ')}</dd>
        </div>
      ) : null}
      {block.outputs.map((output) => (
        <div key={output.id}>
          <dt className="mb-1 font-medium" style={{ color: toneColor[output.tone] }}>
            {output.label}
          </dt>
          <dd className="text-muted">
            Usually followed by {output.next.map((id) => blocks[id].label).join(', ')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The values of a condition block; its field is fixed by the block. */
function ConditionForm({
  node,
  options,
  onChange,
}: {
  node: ConditionNode
  options: PickerOptions
  onChange: (node: PolicyNode) => void
}) {
  const condition = node.condition
  const set = (values: string[]) =>
    onChange({ ...node, condition: { ...condition, values } as Condition })
  const picker = (list: Option[], empty: string) =>
    list.length === 0 ? (
      <p className="text-xs text-subtle">{empty}</p>
    ) : (
      <CheckboxGroup options={list} value={condition.values} onChange={set} />
    )

  let editor: React.ReactNode
  switch (condition.field) {
    case 'kind':
      editor = picker(kinds, '')
      break
    case 'source':
      editor = picker(sources, '')
      break
    case 'deviceStatus':
      editor = picker(deviceStatuses, '')
      break
    case 'tier':
      editor = picker(tiers, '')
      break
    case 'keyStorage':
      editor = picker(keyStorages, '')
      break
    case 'mcpServer':
      editor = picker(options.servers, 'No MCP servers connected yet.')
      break
    case 'resource':
      editor = picker(options.resources, 'No resources defined yet.')
      break
    case 'group':
      editor = picker(options.groups, 'No groups defined yet.')
      break
    case 'tool':
    case 'model':
      editor = (
        <Input
          key={node.id}
          defaultValue={condition.values.join(', ')}
          placeholder={
            condition.field === 'tool'
              ? 'Bash, delete_*, github__create_issue'
              : 'claude-opus-*, llama*'
          }
          onChange={(e) =>
            set(
              e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            )
          }
        />
      )
      break
  }

  return (
    <Field
      label="Yes when it is any of"
      hint={
        condition.field === 'tool' || condition.field === 'model'
          ? `Comma-separated, * as wildcard.${condition.field === 'tool' ? ' MCP tools match with or without the server prefix.' : ''}`
          : undefined
      }
    >
      {editor}
    </Field>
  )
}
