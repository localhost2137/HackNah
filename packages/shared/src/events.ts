import { z } from 'zod'

/** `agent_message` is a message one agent hands to another (a delegated task or its result). */
export const eventKind = z.enum(['model_request', 'tool_call', 'agent_message'])
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

/**
 * How a held request gets approved. `admin` waits for an administrator in the dashboard; the
 * others ask the person at the device (plugin approval levels `confirm`, `touchid`, `browser`).
 */
export const approvalMethod = z.enum(['admin', 'confirm', 'touchid', 'browser'])
export type ApprovalMethod = z.infer<typeof approvalMethod>

export const checkOutcome = z.enum(['pass', 'fail', 'error', 'skipped'])
export type CheckOutcome = z.infer<typeof checkOutcome>

/** Which published workflow version took part in a decision. */
export const workflowRef = z.object({ id: z.string(), name: z.string(), version: z.number() })
export type WorkflowRef = z.infer<typeof workflowRef>

export const checkResult = z.object({
  /** The workflow this step belongs to; absent for checks outside any workflow. */
  workflowId: z.string().optional(),
  stepId: z.string(),
  type: z.string(),
  outcome: checkOutcome,
  /** The output the request left this node through. */
  branch: z.string().optional(),
  action: z.enum(['block', 'require_approval', 'log']).optional(),
  /** Set on a decision that asks for approval. */
  method: approvalMethod.optional(),
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
  /** Every workflow that ran; empty when none matched and the request was allowed. */
  workflows: z.array(workflowRef),
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
  method?: ApprovalMethod
  createdAt: string
  expiresAt: string
}
