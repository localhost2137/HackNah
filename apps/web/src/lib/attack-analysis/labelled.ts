import type { EvaluationInput, EventKind } from '@acl/shared'
import { base } from './catalog.ts'
import { type datasets, trafficWindow } from './datasets.ts'
import { trafficSchedule } from './timeline.ts'
import type { TrafficEvent } from './traffic.ts'

/**
 * Labelled datasets (the rows on the Attack analysis page) as replayable traffic. Their ids carry a
 * prefix so they never collide with the built-in synthetic datasets.
 */
const PREFIX = 'ds-'
const MAX_EVENTS = 2500

export type DatasetInfo = (typeof datasets)[number] & { labelled?: boolean; url?: string }
type Summary = {
  slug: string
  name: string
  url: string
  rows: number
  attacks: number
  benign: number
  byAttack: Record<string, number>
}
type Row = { text: string; attack: string; channel: string; label: string; toolName: string | null }

export const isLabelled = (datasetId: string) => datasetId.startsWith(PREFIX)
export const labelledSlug = (datasetId: string) => datasetId.slice(PREFIX.length)

function seedOf(slug: string): number {
  let h = 2166136261
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619) >>> 0
  return h % 100_000
}

export function labelledInfo(summary: Summary): DatasetInfo {
  const kinds = Object.keys(summary.byAttack).map((k) => k.replace(/_/g, ' '))
  return {
    id: `${PREFIX}${summary.slug}`,
    name: summary.name,
    description:
      summary.attacks === 0
        ? `${summary.benign.toLocaleString()} normal requests that should all pass. Measures false blocks.`
        : `${summary.attacks.toLocaleString()} labelled attacks (${kinds.join(', ')}) and ${summary.benign.toLocaleString()} benign requests.`,
    tag: summary.attacks === 0 ? 'Benign' : 'Labelled',
    eventCount: Math.min(summary.rows, MAX_EVENTS),
    templatePrefix: '',
    seed: seedOf(summary.slug),
    labelled: true,
    url: summary.url,
  }
}

const stageOf: Record<string, EventKind> = {
  user_input: 'model_request',
  tool_arguments: 'tool_call',
  tool_result: 'tool_result',
  model_output: 'model_output',
  agent_message: 'agent_message',
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * One replayable event per row, spread over the same synthetic day as the built-in datasets.
 * Larger datasets are sampled evenly. Every row runs from a healthy, trusted device, so a block
 * comes from the content checks and not from device signals.
 */
export function labelledTraffic(info: DatasetInfo, rows: Row[]): TrafficEvent[] {
  const usable = rows.filter((r) => stageOf[r.channel])
  const step = Math.max(1, Math.ceil(usable.length / MAX_EVENTS))
  const sampled = usable.filter((_, i) => i % step === 0).slice(0, MAX_EVENTS)
  const schedule = trafficSchedule(sampled.length, info.seed)
  const events = sampled.map((row, i): TrafficEvent => {
    const { session, timestamp } = schedule[i] ?? {
      session: i,
      timestamp: trafficWindow.start,
    }
    const kind = stageOf[row.channel]!
    const attack = row.attack !== 'benign'
    const toolCall = kind === 'tool_call'
    const input: EvaluationInput = {
      ...base,
      kind,
      text: row.text,
      toolName: toolCall ? (row.toolName ?? 'Bash') : kind === 'tool_result' ? row.toolName : null,
      toolArguments: toolCall ? parseArguments(row.text) : undefined,
      toolTier: toolCall ? 'write' : null,
      model: 'anthropic/claude-sonnet-4.5',
    }
    const actor = session % 24
    return {
      id: `${info.id}-${String(i + 1).padStart(5, '0')}`,
      title: `${row.attack.replace(/_/g, ' ')} · ${row.channel.replace(/_/g, ' ')}`,
      family: row.attack,
      published: '',
      source: { title: info.name, url: info.url ?? '' },
      expected: attack ? 'block' : 'allow',
      rationale: attack
        ? `Labelled ${row.attack.replace(/_/g, ' ')}${row.label ? ` (${row.label})` : ''} in ${info.name}: it should be blocked.`
        : `Labelled benign in ${info.name}: it should be allowed.`,
      input,
      datasetId: info.id,
      occurredAt: timestamp,
      sessionId: `lab_${String(session).padStart(4, '0')}`,
      actor: {
        id: `synthetic-user-${actor + 1}`,
        name: `Analyst ${actor + 1}`,
        email: `analyst-${actor + 1}@example.invalid`,
      },
      variant: row.label || row.attack.replace(/_/g, ' '),
    }
  })
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
}
