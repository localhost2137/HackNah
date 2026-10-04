import { event, user } from '@acl/db'
import { z } from 'zod'

export const exportFormat = z.enum(['csv', 'jsonl'])
export type ExportFormat = z.infer<typeof exportFormat>

/** The newest events past this are left out; narrow the filters to export older ones. */
export const EXPORT_LIMIT = 50_000

/** Event metadata for the export. Payloads stay in R2: they are large and hold prompt content. */
export const exportSelection = {
  seq: event.seq,
  id: event.id,
  createdAt: event.createdAt,
  userId: event.userId,
  userEmail: user.email,
  userName: user.name,
  deviceId: event.deviceId,
  sessionId: event.sessionId,
  traceId: event.traceId,
  kind: event.kind,
  model: event.model,
  mcpServerId: event.mcpServerId,
  toolName: event.toolName,
  decision: event.decision,
  riskScore: event.riskScore,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  cacheReadTokens: event.cacheReadTokens,
  cacheWriteTokens: event.cacheWriteTokens,
  costUsd: event.costUsd,
  gpuMs: event.gpuMs,
  latencyMs: event.latencyMs,
  overheadMs: event.overheadMs,
  upstreamStatus: event.upstreamStatus,
  ip: event.ip,
  country: event.country,
  userAgent: event.userAgent,
  guardrails: event.guardrails,
  checks: event.checks,
}

export type ExportRow = Pick<
  typeof event.$inferSelect,
  Exclude<keyof typeof exportSelection, 'userEmail' | 'userName'>
> & { userEmail: string | null; userName: string | null }

type Cell = string | number | null | undefined

const csvColumns: [string, (r: ExportRow) => Cell][] = [
  ['id', (r) => r.id],
  ['time', (r) => r.createdAt.toISOString()],
  ['user_id', (r) => r.userId],
  ['user_email', (r) => r.userEmail],
  ['user_name', (r) => r.userName],
  ['device_id', (r) => r.deviceId],
  ['session_id', (r) => r.sessionId],
  ['trace_id', (r) => r.traceId],
  ['kind', (r) => r.kind],
  ['model', (r) => r.model],
  ['mcp_server_id', (r) => r.mcpServerId],
  ['tool', (r) => r.toolName],
  ['decision', (r) => r.decision],
  ['risk_score', (r) => r.riskScore],
  ['input_tokens', (r) => r.inputTokens],
  ['output_tokens', (r) => r.outputTokens],
  ['cache_read_tokens', (r) => r.cacheReadTokens],
  ['cache_write_tokens', (r) => r.cacheWriteTokens],
  ['cost_usd', (r) => r.costUsd],
  ['gpu_ms', (r) => r.gpuMs],
  ['latency_ms', (r) => r.latencyMs],
  ['overhead_ms', (r) => r.overheadMs],
  ['upstream_status', (r) => r.upstreamStatus],
  ['ip', (r) => r.ip],
  ['country', (r) => r.country],
  ['user_agent', (r) => r.userAgent],
  [
    'guardrails',
    (r) =>
      r.guardrails
        .map((g) => `${g.name} v${g.version}${g.decision ? `: ${g.decision}` : ''}`)
        .join('; '),
  ],
  [
    'failed_checks',
    (r) =>
      r.checks
        .filter((c) => c.outcome === 'fail')
        .map((c) => c.type)
        .join('; '),
  ],
]

/**
 * One CSV field. Text that a spreadsheet would run as a formula is prefixed with a quote, since
 * tool names and user agents come from clients.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvHeader(): string {
  return `${csvColumns.map(([name]) => name).join(',')}\r\n`
}

export function exportLine(format: ExportFormat, row: ExportRow): string {
  if (format === 'csv') return `${csvColumns.map(([, get]) => csvCell(get(row))).join(',')}\r\n`
  const { seq: _seq, createdAt, ...rest } = row
  return `${JSON.stringify({ ...rest, createdAt: createdAt.toISOString() })}\n`
}
