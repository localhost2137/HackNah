import type { PiiKind } from './workflow.ts'

type Detector = {
  label: string
  pattern: RegExp
  /** Index of the capture group to redact; the whole match when omitted. */
  group?: number
  validate?: (value: string) => boolean
}

const secretDetectors: Detector[] = [
  {
    label: 'PRIVATE_KEY',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { label: 'AWS_KEY', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    label: 'GITHUB_TOKEN',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  { label: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'OPENAI_KEY', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { label: 'SLACK_TOKEN', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    label: 'SECRET',
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
    group: 1,
  },
]

const piiDetectors: Record<PiiKind, Detector> = {
  email: { label: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  phone: { label: 'PHONE', pattern: /(?<![\w+])\+\d{1,3}[ -]?(?:\d[ -]?){8,12}\d\b/g },
  iban: {
    label: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    validate: validIban,
  },
  credit_card: { label: 'CARD', pattern: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn },
  ipv4: {
    label: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  pesel: { label: 'PESEL', pattern: /\b\d{11}\b/g, validate: validPesel },
}

export type RedactionOptions = { secrets: boolean; pii: PiiKind[] }

/**
 * Reversible redaction. The same value always maps to the same placeholder within a vault,
 * so the agent can reason about "[REDACTED_EMAIL_1]" consistently and the gateway can put
 * the real value back when the agent passes the placeholder into a tool call.
 */
export class RedactionVault {
  private byValue = new Map<string, string>()
  private byPlaceholder = new Map<string, string>()
  private counters = new Map<string, number>()

  /** `entries` maps placeholder -> original value, as returned by `toJSON()`. */
  constructor(entries: Record<string, string> = {}) {
    for (const [placeholder, value] of Object.entries(entries)) this.remember(placeholder, value)
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.byPlaceholder)
  }

  get size(): number {
    return this.byPlaceholder.size
  }

  redact(text: string, options: RedactionOptions): { text: string; count: number } {
    const detectors = [
      ...(options.secrets ? secretDetectors : []),
      ...options.pii.map((k) => piiDetectors[k]),
    ]
    let count = 0
    let out = text
    for (const d of detectors) {
      out = out.replace(d.pattern, (match: string, ...groups: unknown[]) => {
        const value = d.group ? (groups[d.group - 1] as string | undefined) : match
        if (!value || value.startsWith('[REDACTED_')) return match
        if (d.validate && !d.validate(value)) return match
        count++
        return match.replace(value, this.placeholderFor(d.label, value))
      })
    }
    return { text: out, count }
  }

  restore(text: string): string {
    if (this.byPlaceholder.size === 0) return text
    return text.replace(/\[REDACTED_[A-Z_]+_\d+\]/g, (p) => this.byPlaceholder.get(p) ?? p)
  }

  restoreDeep<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as T
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v)) as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.restoreDeep(v)]),
      ) as T
    }
    return value
  }

  private placeholderFor(label: string, value: string): string {
    const existing = this.byValue.get(value)
    if (existing) return existing
    const n = (this.counters.get(label) ?? 0) + 1
    this.counters.set(label, n)
    const placeholder = `[REDACTED_${label}_${n}]`
    this.remember(placeholder, value)
    return placeholder
  }

  private remember(placeholder: string, value: string) {
    this.byValue.set(value, placeholder)
    this.byPlaceholder.set(placeholder, value)
    const m = /^\[REDACTED_([A-Z_]+)_(\d+)\]$/.exec(placeholder)
    if (m?.[1] && m[2])
      this.counters.set(m[1], Math.max(this.counters.get(m[1]) ?? 0, Number(m[2])))
  }
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function validIban(value: string): boolean {
  const iban = value.replace(/\s/g, '')
  if (iban.length < 15 || iban.length > 34) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const n = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const digit of n) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

function validPesel(value: string): boolean {
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]
  const sum = weights.reduce((acc, w, i) => acc + w * Number(value[i]), 0)
  return (10 - (sum % 10)) % 10 === Number(value[10])
}
