import type { PolicyGraph, PolicyNode } from './workflow.ts'

export type Strictness = 'permissive' | 'balanced' | 'strict'

const column = (n: number, row = 0) => ({ x: n * 340, y: row * 220 })

/**
 * Sample configurations at three strictness levels. They share one shape (device, known attack
 * signatures, keywords, argument rules, redaction) and differ in thresholds:
 *
 * - `permissive`: critical signatures only, secrets redacted, new devices let through.
 * - `balanced`: medium signatures and above, common PII redacted, new devices need approval.
 * - `strict`: every signature, all PII redacted, unconnected outputs block.
 */
export function policyPreset(strictness: Strictness): PolicyGraph {
  const strict = strictness === 'strict'
  const permissive = strictness === 'permissive'
  const nodes: PolicyNode[] = [
    { id: 'start', type: 'trigger', position: column(0) },
    {
      id: 'fingerprint',
      type: 'check',
      position: column(1),
      enabled: true,
      check: { type: 'fingerprint' },
    },
    {
      id: 'signatures',
      type: 'check',
      position: column(2),
      enabled: true,
      check: {
        type: 'signatures',
        minSeverity: strict ? 'low' : permissive ? 'critical' : 'medium',
        categories: [],
      },
    },
    {
      id: 'keywords',
      type: 'check',
      position: column(3),
      enabled: true,
      check: {
        type: 'keywords',
        mode: 'substring',
        caseSensitive: false,
        patterns: ['DROP DATABASE', 'aws_secret_access_key', 'mkfs.', 'dd if=* of=/dev/'],
      },
    },
    {
      id: 'arguments',
      type: 'check',
      position: column(4),
      enabled: true,
      check: {
        type: 'arguments',
        rules: ['to', 'cc', 'bcc'].map((argument) => ({
          tool: 'email_send',
          argument,
          pattern: '@company\\.com$',
          message: `email_send may only send to @company.com addresses (${argument})`,
        })),
      },
    },
    {
      id: 'redact',
      type: 'check',
      position: column(5),
      enabled: true,
      check: {
        type: 'redact',
        secrets: true,
        pii: permissive
          ? []
          : strict
            ? ['email', 'phone', 'iban', 'credit_card', 'ipv4', 'pesel']
            : ['email', 'phone', 'iban', 'credit_card', 'pesel'],
      },
    },
    {
      id: 'allow',
      type: 'decision',
      position: column(6),
      action: 'allow',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    },
    {
      id: 'approve',
      type: 'decision',
      position: column(2, 2),
      action: 'require_approval',
      method: 'admin',
      timeoutSec: 300,
      reason: 'Request from a new device',
    },
    {
      id: 'block',
      type: 'decision',
      position: column(6, 1),
      action: 'block',
      method: 'admin',
      timeoutSec: 300,
      reason: '',
    },
  ]
  const edge = (source: string, sourceHandle: string, target: string) => ({
    id: `${source}-${sourceHandle}`,
    source,
    sourceHandle,
    target,
  })
  return {
    fallback: 'block',
    nodes,
    edges: [
      edge('start', 'next', 'fingerprint'),
      edge('fingerprint', 'pass', 'signatures'),
      edge('fingerprint', 'new', permissive ? 'signatures' : 'approve'),
      edge('fingerprint', 'mismatch', 'block'),
      edge('signatures', 'pass', 'keywords'),
      edge('signatures', 'fail', 'block'),
      edge('keywords', 'pass', 'arguments'),
      edge('keywords', 'fail', 'block'),
      edge('arguments', 'pass', 'redact'),
      edge('arguments', 'fail', 'block'),
      edge('redact', 'pass', 'allow'),
    ],
  }
}
