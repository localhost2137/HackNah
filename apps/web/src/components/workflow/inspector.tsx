import type { Condition, GraphIssue, MatchNode, PolicyNode } from '@acl/shared'
import { checkLabels } from '@acl/shared'
import { Button, Field, Input, Select, Switch } from '@acl/ui'
import { Plus, Trash2, X } from 'lucide-react'
import { CheckboxGroup, CheckForm } from './step-form.tsx'

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
]

const kinds: Option[] = [
  { value: 'model_request', label: 'Prompts' },
  { value: 'tool_call', label: 'Tool calls' },
]

const deviceStatuses: Option[] = [
  { value: 'trusted', label: 'Trusted' },
  { value: 'new', label: 'New' },
  { value: 'mismatch', label: 'Mismatch' },
]

function nodeTitle(node: PolicyNode): string {
  switch (node.type) {
    case 'trigger':
      return 'Request comes in'
    case 'match':
      return 'Route'
    case 'check':
      return checkLabels[node.check.type]
    case 'decision':
      return 'Decision'
  }
}

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
          <div className="text-[13px] font-semibold">{nodeTitle(node)}</div>
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
  switch (node.type) {
    case 'trigger':
      return (
        <p className="text-xs text-muted">
          Every prompt, tool result and tool call starts here. Connect it to routes that send
          different tools down stricter or looser paths.
        </p>
      )
    case 'match':
      return <MatchForm node={node} options={options} onChange={onChange} />
    case 'check':
      return (
        <>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={node.enabled}
              onCheckedChange={(enabled) => onChange({ ...node, enabled })}
            />
            Enabled
          </label>
          <CheckForm check={node.check} onChange={(check) => onChange({ ...node, check })} />
        </>
      )
    case 'decision':
      return (
        <>
          <Field label="Action">
            <Select
              value={node.action}
              onChange={(e) => onChange({ ...node, action: e.target.value as typeof node.action })}
            >
              <option value="allow">Allow</option>
              <option value="require_approval">Require approval</option>
              <option value="block">Block</option>
            </Select>
          </Field>
          {node.action === 'require_approval' ? (
            <Field label="Approval timeout (seconds)" hint="Declined when nobody decides in time.">
              <Input
                type="number"
                min={10}
                max={3600}
                value={node.timeoutSec}
                onChange={(e) => onChange({ ...node, timeoutSec: Number(e.target.value) })}
              />
            </Field>
          ) : null}
          {node.action !== 'allow' ? (
            <Field label="Reason" hint="Shown to the user and in the approval queue.">
              <Input
                value={node.reason}
                maxLength={200}
                onChange={(e) => onChange({ ...node, reason: e.target.value })}
              />
            </Field>
          ) : null}
        </>
      )
  }
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
  const setConditions = (conditions: Condition[]) => onChange({ ...node, conditions })
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
      <Field label="Matches when">
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
