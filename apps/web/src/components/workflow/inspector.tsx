import type {
  BlockId,
  Condition,
  GraphIssue,
  MatchNode,
  PolicyNode,
  TriggerNode,
} from '@acl/shared'
import { blockOf, blocks, inputLabels, palette } from '@acl/shared'
import { Button, Field, Input, Select, Switch } from '@acl/ui'
import { Plus, Trash2, X } from 'lucide-react'
import { toneColor } from './graph-nodes.tsx'
import { CheckboxGroup, FieldForm } from './step-form.tsx'

export type Option = { value: string; label: string }
export type PickerOptions = { servers: Option[]; resources: Option[]; groups: Option[] }

const fields: { value: Condition['field']; label: string }[] = [
  { value: 'kind', label: 'Request kind' },
  { value: 'mcpServer', label: 'MCP server' },
  { value: 'tool', label: 'Tool name' },
  { value: 'resource', label: 'Resource' },
  { value: 'group', label: 'User group' },
  { value: 'deviceStatus', label: 'Device status' },
  { value: 'model', label: 'Model' },
  { value: 'tier', label: 'Tool tier' },
  { value: 'keyStorage', label: 'Device key storage' },
]

const kinds: Option[] = [
  { value: 'model_request', label: 'Prompts' },
  { value: 'tool_call', label: 'Tool calls' },
  { value: 'agent_message', label: 'Agent-to-agent messages' },
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
      <fieldset disabled={readOnly} className="flex flex-col gap-4 p-4">
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
      <p className="text-xs text-muted">{block.description}</p>
      {node.type === 'check' ? (
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={node.enabled}
            onCheckedChange={(enabled) => onChange({ ...node, enabled })}
          />
          Enabled
        </label>
      ) : null}
      {node.type === 'match' ? (
        <MatchForm node={node} options={options} onChange={onChange} />
      ) : node.type === 'trigger' ? (
        <TriggerForm node={node} options={options} onChange={onChange} />
      ) : node.type === 'check' ? (
        <FieldForm
          fields={block.fields}
          value={node.check}
          onChange={(patch) =>
            onChange({ ...node, check: { ...node.check, ...patch } } as PolicyNode)
          }
        />
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

function MatchForm({
  node,
  options,
  onChange,
}: {
  node: MatchNode
  options: PickerOptions
  onChange: (node: PolicyNode) => void
}) {
  return (
    <>
      <Field label="Label">
        <Input
          value={node.label}
          maxLength={80}
          placeholder="GitHub write tools"
          onChange={(e) => onChange({ ...node, label: e.target.value })}
        />
      </Field>
      <ConditionsForm label="Matches when" node={node} options={options} onChange={onChange} />
    </>
  )
}

function TriggerForm({
  node,
  options,
  onChange,
}: {
  node: TriggerNode
  options: PickerOptions
  onChange: (node: PolicyNode) => void
}) {
  return (
    <>
      {node.conditions.length === 0 ? (
        <p className="rounded-md border border-line p-3 text-xs text-muted">
          No conditions: every prompt and tool call starts this workflow.
        </p>
      ) : null}
      <ConditionsForm label="Starts when" node={node} options={options} onChange={onChange} />
    </>
  )
}

function ConditionsForm<T extends MatchNode | TriggerNode>({
  label,
  node,
  options,
  onChange,
}: {
  label: string
  node: T
  options: PickerOptions
  onChange: (node: T) => void
}) {
  const setConditions = (conditions: Condition[]) => onChange({ ...node, conditions })
  return (
    <>
      <Field label={label}>
        <Select
          value={node.mode}
          onChange={(e) => onChange({ ...node, mode: e.target.value as 'all' | 'any' })}
        >
          <option value="all">All conditions hold</option>
          <option value="any">Any condition holds</option>
        </Select>
      </Field>
      <div className="flex flex-col gap-3">
        {node.conditions.map((c, i) => (
          <ConditionRow
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity of their own
            key={i}
            condition={c}
            options={options}
            onChange={(next) => setConditions(node.conditions.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setConditions(node.conditions.filter((_, j) => j !== i))}
          />
        ))}
        <Button
          size="sm"
          onClick={() => setConditions([...node.conditions, { field: 'tool', values: [] }])}
        >
          <Plus className="size-3.5" /> Add condition
        </Button>
      </div>
    </>
  )
}

function ConditionRow({
  condition,
  options,
  onChange,
  onRemove,
}: {
  condition: Condition
  options: PickerOptions
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  const picker = (list: Option[], empty: string) =>
    list.length === 0 ? (
      <p className="text-xs text-subtle">{empty}</p>
    ) : (
      <CheckboxGroup
        options={list}
        value={condition.values}
        onChange={(values) => onChange({ ...condition, values } as Condition)}
      />
    )

  let editor: React.ReactNode
  switch (condition.field) {
    case 'kind':
      editor = picker(kinds, '')
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
          key={condition.field}
          defaultValue={condition.values.join(', ')}
          placeholder={condition.field === 'tool' ? 'delete_*, create_*, Bash' : 'anthropic/*'}
          onChange={(e) =>
            onChange({
              ...condition,
              values: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
        />
      )
      break
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex items-center gap-2">
        <Select
          className="h-7 flex-1"
          value={condition.field}
          onChange={(e) => onChange({ field: e.target.value, values: [] } as Condition)}
        >
          {fields.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove condition">
          <X className="size-3.5" />
        </Button>
      </div>
      {editor}
      {condition.field === 'tool' ? (
        <p className="text-[11px] text-subtle">
          Comma-separated, * as wildcard. MCP tools match with or without the server prefix.
        </p>
      ) : null}
    </div>
  )
}
