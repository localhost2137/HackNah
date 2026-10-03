import { z } from 'zod'
import { eventKind } from './events.ts'

export const stepAction = z.enum(['block', 'require_approval', 'log'])
export type StepAction = z.infer<typeof stepAction>

const base = {
  id: z.string().min(1),
  enabled: z.boolean().default(true),
}

export const fingerprintStep = z.object({
  ...base,
  type: z.literal('fingerprint'),
  /** A device the user has never used before (or one still waiting for approval). */
  onNewDevice: stepAction.default('require_approval'),
  /** The token was issued to a different device than the one presenting it. */
  onMismatch: stepAction.default('block'),
})

export const keywordsStep = z.object({
  ...base,
  type: z.literal('keywords'),
  patterns: z.array(z.string().min(1)).default([]),
  mode: z.enum(['substring', 'regex']).default('substring'),
  caseSensitive: z.boolean().default(false),
  appliesTo: z.array(eventKind).default(['model_request', 'tool_call']),
  action: stepAction.default('block'),
})

export const judgeStep = z.object({
  ...base,
  type: z.literal('judge'),
  /** OpenAI-compatible chat completions endpoint of the self-hosted judge model. */
  endpoint: z.url(),
  model: z.string().min(1),
  /** Risk score in [0, 1] at or above which the step fails. */
  threshold: z.number().min(0).max(1).default(0.7),
  timeoutMs: z.number().int().min(100).max(30_000).default(4000),
  failOpen: z.boolean().default(true),
  instructions: z.string().default(''),
  appliesTo: z.array(eventKind).default(['model_request', 'tool_call']),
  action: stepAction.default('require_approval'),
})

export const piiKind = z.enum(['email', 'phone', 'iban', 'credit_card', 'ipv4', 'pesel'])
export type PiiKind = z.infer<typeof piiKind>

export const redactStep = z.object({
  ...base,
  type: z.literal('redact'),
  secrets: z.boolean().default(true),
  pii: z.array(piiKind).default(['email', 'phone', 'iban', 'credit_card']),
})

export const workflowStep = z.discriminatedUnion('type', [
  fingerprintStep,
  keywordsStep,
  judgeStep,
  redactStep,
])
export type WorkflowStep = z.infer<typeof workflowStep>
export type StepType = WorkflowStep['type']

export const workflowDefinition = z.object({
  steps: z.array(workflowStep),
  approvalTimeoutSec: z.number().int().min(10).max(3600).default(300),
})
export type WorkflowDefinition = z.infer<typeof workflowDefinition>

export const defaultWorkflow: WorkflowDefinition = {
  approvalTimeoutSec: 300,
  steps: [
    {
      id: 'fingerprint',
      type: 'fingerprint',
      enabled: true,
      onNewDevice: 'require_approval',
      onMismatch: 'block',
    },
    {
      id: 'keywords',
      type: 'keywords',
      enabled: true,
      patterns: ['rm -rf /', 'DROP DATABASE', 'curl * | sh', 'aws_secret_access_key'],
      mode: 'substring',
      caseSensitive: false,
      appliesTo: ['model_request', 'tool_call'],
      action: 'block',
    },
  ],
}

export const stepLabels: Record<StepType, string> = {
  fingerprint: 'Device fingerprint',
  keywords: 'Dangerous keywords',
  judge: 'Judge model',
  redact: 'Redact secrets and PII',
}

export const rateLimitRule = z.object({
  id: z.string(),
  scope: z.enum(['mcp', 'tool', 'resource']),
  /** MCP server id, `<server>__<tool>` name, or resource id. `*` matches any target in scope. */
  target: z.string().min(1),
  limit: z.number().int().min(1),
  windowSec: z.number().int().min(1).max(86_400),
  per: z.enum(['user', 'org']).default('user'),
})
export type RateLimitRule = z.infer<typeof rateLimitRule>
