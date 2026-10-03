import { z } from 'zod'

export const eventKind = z.enum(['model_request', 'tool_call'])
export type EventKind = z.infer<typeof eventKind>

export const decision = z.enum([
  'allow',
  'block',
  'pending',
  'approved',
  'declined',
  'rate_limited',
])
export type Decision = z.infer<typeof decision>

export const checkOutcome = z.enum(['pass', 'fail', 'error', 'skipped'])
export type CheckOutcome = z.infer<typeof checkOutcome>

export const checkResult = z.object({
  stepId: z.string(),
  type: z.string(),
  outcome: checkOutcome,
  action: z.enum(['block', 'require_approval', 'log']).optional(),
  reason: z.string().optional(),
  score: z.number().optional(),
  durationMs: z.number(),
})
export type CheckResult = z.infer<typeof checkResult>

/** Metadata for one gateway request. The full payload lives in R2 under `payloadKey`. */
export const gatewayEvent = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  deviceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  kind: eventKind,
  model: z.string().nullable(),
  mcpServerId: z.string().nullable(),
  toolName: z.string().nullable(),
  resourceIds: z.array(z.string()),
  decision,
  checks: z.array(checkResult),
  riskScore: z.number(),
  workflowVersion: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  latencyMs: z.number(),
  upstreamStatus: z.number().nullable(),
  ip: z.string().nullable(),
  country: z.string().nullable(),
  userAgent: z.string().nullable(),
  payloadKey: z.string().nullable(),
  createdAt: z.string(),
})
export type GatewayEvent = z.infer<typeof gatewayEvent>

/** What is stored in R2 for each event, so new rules can be replayed against past traffic. */
export const eventPayload = z.object({
  input: z.object({
    text: z.string(),
    toolName: z.string().nullable(),
    toolArguments: z.unknown().optional(),
  }),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
})
export type EventPayload = z.infer<typeof eventPayload>

/** Messages pushed over the live WebSocket to dashboards. */
export type LiveMessage =
  | { type: 'event'; event: GatewayEvent }
  | { type: 'approval_created'; approval: ApprovalView }
  | { type: 'approval_decided'; approvalId: string; status: 'approved' | 'declined' | 'expired' }

export type ApprovalView = {
  id: string
  eventId: string
  userId: string
  sessionId: string | null
  deviceId: string | null
  kind: EventKind
  summary: string
  reasons: string[]
  createdAt: string
  expiresAt: string
}
