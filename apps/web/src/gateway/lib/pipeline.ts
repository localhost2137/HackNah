import { approval, type Db } from '@acl/db'
import {
  type ApprovalView,
  type CheckResult,
  callJudge,
  type Decision,
  type EvaluationInput,
  evaluateWorkflows,
  type RedactConfig,
  randomId,
  type WorkflowRef,
} from '@acl/shared'
import { eq } from 'drizzle-orm'
import type { Principal } from '../context.ts'
import { approvalsStub } from '../do/approvals.ts'
import { effectivePermissions, permissionDenial, userGroupIds } from './access.ts'
import { loadSignatures } from './signatures.ts'
import { loadActiveWorkflows } from './workflow.ts'

export type PipelineResult = {
  decision: Extract<Decision, 'allow' | 'block' | 'approved' | 'declined'>
  checks: CheckResult[]
  riskScore: number
  reasons: string[]
  workflows: WorkflowRef[]
  approvalId: string | null
  redact: RedactConfig | null
}

function judgeApiKey(env: Env, endpoint: string): string | undefined {
  if (new URL(endpoint).hostname === 'openrouter.ai') return env.OPENROUTER_API_KEY
  return env.JUDGE_API_KEY || undefined
}

/**
 * Runs every workflow the request triggers and keeps the strictest outcome. A request that
 * triggers none is allowed. If the outcome is an approval, this blocks until someone decides in
 * the dashboard or the approval times out.
 *
 * Device-side approvals (confirm, Touch ID, browser) pass on their own when the request carries
 * the proof in `input.signals`. Until the gateway issues the plugin's challenges, a request
 * without that proof waits in the same queue, labelled with the method it asked for.
 */
export async function runPipeline(
  env: Env,
  db: Db,
  principal: Principal,
  input: Omit<EvaluationInput, 'deviceStatus' | 'groupIds'>,
  meta: { eventId: string; sessionId: string | null; summary: string },
): Promise<PipelineResult> {
  const [workflows, groupIds, permissions] = await Promise.all([
    loadActiveWorkflows(db, principal.orgId),
    userGroupIds(db, principal),
    effectivePermissions(db, principal),
  ])
  const denied = permissionDenial(permissions, input)
  if (denied) {
    return {
      decision: 'block',
      checks: [
        {
          stepId: 'permissions',
          type: 'permissions',
          outcome: 'fail',
          action: 'block',
          reason: denied,
          durationMs: 0,
        },
      ],
      riskScore: 1,
      reasons: [denied],
      workflows: [],
      approvalId: null,
      redact: null,
    }
  }
  const usesSignatures = workflows.some((w) =>
    w.definition.nodes.some(
      (n) => n.type === 'check' && n.enabled && n.check.type === 'signatures',
    ),
  )
  const result = await evaluateWorkflows(
    workflows,
    { ...input, groupIds, deviceStatus: principal.deviceStatus },
    {
      judge: (check, i) => callJudge(check, i, { apiKey: judgeApiKey(env, check.endpoint) }),
      signatures: usesSignatures ? (await loadSignatures(env)).signatures : undefined,
    },
  )
  const base = {
    checks: result.checks,
    riskScore: result.riskScore,
    reasons: result.reasons,
    workflows: result.workflows,
    approvalId: null,
    redact: result.redact,
  }
  if (result.decision === 'allow') return { ...base, decision: 'allow' }
  if (result.decision === 'block') return { ...base, decision: 'block' }

  const timeoutMs = result.approvalTimeoutSec * 1000
  const now = new Date()
  const trustsDevice = principal.deviceStatus === 'new' && result.trustsDevice
  const view: ApprovalView = {
    id: randomId('apr'),
    eventId: meta.eventId,
    userId: principal.userId,
    sessionId: meta.sessionId,
    deviceId: principal.deviceId,
    kind: input.kind,
    summary: meta.summary,
    reasons: result.reasons,
    method: result.approvalMethod ?? 'admin',
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
