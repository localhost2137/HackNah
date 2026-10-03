import type { Decision } from '@acl/shared'
import type { BadgeTone } from '@acl/ui'

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })

export function timeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const diff = (d.getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour')
  return rtf.format(Math.round(diff / 86_400), 'day')
}

export function dateTime(date: Date | string): string {
  return new Date(date).toLocaleString('en-GB', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
export function num(n: number | null | undefined): string {
  return n == null ? '—' : compact.format(n)
}

export function pct(part: number, total: number): string {
  if (!total) return '0%'
  return `${((part / total) * 100).toFixed(part / total < 0.1 ? 1 : 0)}%`
}

export const decisionMeta: Record<Decision, { label: string; tone: BadgeTone }> = {
  allow: { label: 'Allowed', tone: 'ok' },
  approved: { label: 'Approved', tone: 'info' },
  pending: { label: 'Pending', tone: 'warn' },
  block: { label: 'Blocked', tone: 'bad' },
  declined: { label: 'Declined', tone: 'bad' },
  rate_limited: { label: 'Rate limited', tone: 'warn' },
}

export function riskTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 0.7) return 'bad'
  if (score >= 0.3) return 'warn'
  return 'ok'
}
