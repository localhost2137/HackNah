import { describe, expect, it } from 'vitest'
import { csvCell, csvHeader, type ExportRow, exportLine } from './events-export.ts'

const row: ExportRow = {
  seq: 7,
  id: 'evt_1',
  createdAt: new Date('2026-10-04T05:00:00.000Z'),
  userId: 'u1',
  userEmail: 'maya@demo.test',
  userName: 'Chen, Maya',
  deviceId: null,
  sessionId: 's1',
  kind: 'model_request',
  model: 'anthropic/claude-sonnet-4.5',
  mcpServerId: null,
  toolName: null,
  decision: 'allow',
  riskScore: 0.12,
  inputTokens: 24,
  outputTokens: 737,
  cacheReadTokens: 46054,
  cacheWriteTokens: 1947,
  costUsd: 0.0107,
  gpuMs: null,
  latencyMs: 2100,
  overheadMs: 4,
  upstreamStatus: 200,
  ip: '198.51.100.24',
  country: 'PL',
  userAgent: '=HYPERLINK("https://evil.example")',
  guardrails: [{ id: 'g1', name: 'Secrets', version: 2, decision: 'allow' }],
  checks: [
    { stepId: 'a', type: 'secret_scan', outcome: 'fail', durationMs: 1 },
    { stepId: 'b', type: 'classifier', outcome: 'pass', durationMs: 3 },
  ],
}

describe('events export', () => {
  it('quotes CSV fields and defuses spreadsheet formulas', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(0)).toBe('0')
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"')
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('-cmd')).toBe("'-cmd")
  })

  it('writes one CSV line per event with the same columns as the header', () => {
    const line = exportLine('csv', row)
    expect(line.endsWith('\r\n')).toBe(true)
    expect(line).toContain('"Chen, Maya"')
    expect(line).toContain(`"'=HYPERLINK(""https://evil.example"")"`)
    expect(line).toContain(',24,737,46054,1947,0.0107,')
    expect(line.trimEnd().endsWith('Secrets v2: allow,secret_scan')).toBe(true)
    expect(csvHeader().split(',')).toHaveLength(27)
  })

  it('writes JSONL with the nested checks and without the cursor', () => {
    const parsed = JSON.parse(exportLine('jsonl', row))
    expect(parsed.seq).toBeUndefined()
    expect(parsed.createdAt).toBe('2026-10-04T05:00:00.000Z')
    expect(parsed.checks).toHaveLength(2)
    expect(parsed.cacheWriteTokens).toBe(1947)
  })
})
