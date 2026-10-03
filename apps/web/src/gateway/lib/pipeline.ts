import { approval, type Db } from '@acl/db'
import {
  type ApprovalView,
  type CheckResult,
  callJudge,
  type Decision,
  type EvaluationInput,
  evaluate,
  randomId,
} from '@acl/shared'
import { eq } from 'drizzle-orm'
import type { Principal } from '../context.ts'
import { approvalsStub } from '../do/approvals.ts'
import { loadActiveWorkflow } from './workflow.ts'

export type PipelineResult = {
  decision: Extract<Decision, 'allow' | 'block' | 'approved' | 'declined'>
  checks: CheckResult[]
  riskScore: number
  reasons: string[]
  workflowVersion: number | null
  approvalId: string | null
}

function judgeApiKey(env: Env, endpoint: string): string | undefined {
  if (new URL(endpoint).hostname === 'openrouter.ai') return env.OPENROUTER_API_KEY
  return env.JUDGE_API_KEY || undefined
}

/**
 * Runs the org's shared workflow for one request. If a step asks for approval, this blocks
 * until someone decides in the dashboard or the approval times out.
 */
export async function runPipeline(
  env: Env,
  db: Db,
  principal: Principal,
  input: Omit<EvaluationInput, 'deviceStatus'>,
  meta: { eventId: string; sessionId: string | null; summary: string },
): Promise<PipelineResult> {
  const workflow = await loadActiveWorkflow(db, principal.orgId)
  const result = await evaluate(
    workflow.definition,
    { ...input, deviceStatus: principal.deviceStatus },
    { judge: (step, i) => callJudge(step, i, { apiKey: judgeApiKey(env, step.endpoint) }) },
  )
  const base = {
    checks: result.checks,
    riskScore: result.riskScore,
    reasons: result.reasons,
    workflowVersion: workflow.version,
    approvalId: null,
  }
  if (result.decision === 'allow') return { ...base, decision: 'allow' }
  if (result.decision === 'block') return { ...base, decision: 'block' }

  const timeoutMs = workflow.definition.approvalTimeoutSec * 1000
  const now = new Date()
  const trustsDevice =
    principal.deviceStatus === 'new' &&
    result.checks.some(
      (c) => c.type === 'fingerprint' && c.outcome === 'fail' && c.action === 'require_approval',
    )
  const view: ApprovalView = {
    id: randomId('apr'),
    eventId: meta.eventId,
    userId: principal.userId,
    sessionId: meta.sessionId,
    deviceId: principal.deviceId,
    kind: input.kind,
    summary: meta.summary,
    reasons: result.reasons,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
  }

  const hub = approvalsStub(env, principal.orgId)
  const { approvalId, created } = await hub.register(
    view,
    trustsDevice ? `device:${principal.deviceId}` : undefined,
  )
  if (created) {
    await db.insert(approval).values({
      id: view.id,
      orgId: principal.orgId,
      eventId: view.eventId,
      userId: view.userId,
      sessionId: view.sessionId,
      deviceId: view.deviceId,
      kind: view.kind,
      summary: view.summary,
      reasons: view.reasons,
      trustsDevice,
      expiresAt: new Date(view.expiresAt),
    })
  }

  let status: 'approved' | 'declined' | 'expired'
  try {
    status = await hub.wait(approvalId, timeoutMs)
  } catch {
    status = 'expired'
  }
  if (status === 'expired' && created) {
    await db.update(approval).set({ status: 'expired' }).where(eq(approval.id, approvalId))
  }
  return {
    ...base,
    approvalId,
    decision: status === 'approved' ? 'approved' : 'declined',
    reasons: status === 'expired' ? [...result.reasons, 'Approval timed out'] : result.reasons,
  }
}

export function denialMessage(result: PipelineResult): string {
  const why = result.reasons.join('; ') || 'policy'
  if (result.decision === 'declined') return `Request declined by an administrator (${why}).`
  return `Request blocked by AI Control Layer policy: ${why}.`
}
