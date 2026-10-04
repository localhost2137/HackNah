import { type Db, event, group, groupMember, mcpServer, user } from '@acl/db'
import {
  type ActiveWorkflow,
  type EvaluationInput,
  type EventKind,
  eventPayload,
  policyGraph,
  type RecordedResult,
  type ReplayOutcome,
  recordedDeviceStatus,
  replayWithShadow,
  selectWorkflows,
  toolTierFromAnnotations,
} from '@acl/shared'
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'
import { rangeMs, timeRange } from './traffic.ts'
import { findWorkflow } from './workflow.ts'

/** Every event may read one R2 payload; this keeps a batch well under the subrequest limit. */
const BATCH = 200
const MAX_AFFECTED = 50

export type AffectedRequest = {
  id: string
  createdAt: Date
  userName: string | null
  kind: EventKind
  target: string
  recorded: RecordedResult
  shadow: ReplayOutcome | 'not_started'
  before: ReplayOutcome
  after: ReplayOutcome
  reason: string | null
}

/**
 * Replays one page of recorded traffic, newest first, through an unpublished graph. The browser
 * calls it again with `nextCursor` until the range is done.
 */
export const replayShadow = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      workflowId: z.string(),
      definition: policyGraph,
      range: timeRange,
      judge: z.enum(['recorded', 'pass', 'fail']),
      cursor: z.number().optional(),
    }),
  )
  .handler(async ({ data, context: { db, orgId } }) => {
    const meta = await findWorkflow(db, orgId, data.workflowId)
    const shadow: ActiveWorkflow = {
      id: meta.id,
      name: meta.name,
      version: 0,
      groupIds: meta.groupIds,
      definition: data.definition,
    }
    const scope = and(
      eq(event.orgId, orgId),
      gte(event.createdAt, new Date(Date.now() - rangeMs[data.range])),
    )
    const [rows, total, groups, tierOf] = await Promise.all([
      db
        .select({
          seq: event.seq,
          id: event.id,
          userId: event.userId,
          userName: user.name,
          kind: event.kind,
          model: event.model,
          mcpServerId: event.mcpServerId,
          toolName: event.toolName,
          resourceIds: event.resourceIds,
          decision: event.decision,
          checks: event.checks,
          payloadKey: event.payloadKey,
          createdAt: event.createdAt,
        })
        .from(event)
        .leftJoin(user, eq(user.id, event.userId))
        .where(and(scope, data.cursor ? lt(event.seq, data.cursor) : undefined))
        .orderBy(desc(event.seq))
        .limit(BATCH + 1),
      data.cursor
        ? null
        : db
            .select({ n: count() })
            .from(event)
            .where(scope)
            .then((r) => r[0]?.n ?? 0),
      groupsByUser(db, orgId),
      toolTiers(db, orgId),
    ])
    const page = rows.slice(0, BATCH)

    const verdicts: Record<string, number> = {}
    const transitions: Record<string, number> = {}
    const affected: AffectedRequest[] = []

    await Promise.all(
      page.map(async (row) => {
        const input: EvaluationInput = {
          kind: row.kind,
          text: '',
          toolName: row.toolName,
          mcpServerId: row.mcpServerId,
          model: row.model,
          resourceIds: row.resourceIds,
          groupIds: groups.get(row.userId) ?? groups.get('*') ?? [],
          deviceStatus: recordedDeviceStatus(row.checks),
          toolTier: tierOf(row.mcpServerId, row.toolName),
        }
        if (selectWorkflows([shadow], input).length > 0) {
          const payload = await readPayload(orgId, row.payloadKey)
          input.text = payload?.text ?? ''
          input.toolArguments = payload?.toolArguments
        }
        const recordedScore = Math.max(
          0,
          ...row.checks.flatMap((c) => (c.type === 'judge' && c.score != null ? [c.score] : [])),
        )
        const verdict = await replayWithShadow(shadow, row, input, {
          judge: async () => ({
            score: data.judge === 'fail' ? 1 : data.judge === 'pass' ? 0 : recordedScore,
            reason: 'Replayed judge verdict',
          }),
        })

        const vKey = `${verdict.recorded}>${verdict.shadow}`
        verdicts[vKey] = (verdicts[vKey] ?? 0) + 1
        const tKey = `${verdict.before}>${verdict.after}`
        transitions[tKey] = (transitions[tKey] ?? 0) + 1

        const flagged = verdict.shadow === 'block' || verdict.shadow === 'approval'
        if ((verdict.before !== verdict.after || flagged) && affected.length < MAX_AFFECTED) {
          affected.push({
            id: row.id,
            createdAt: row.createdAt,
            userName: row.userName,
            kind: row.kind,
            target: row.toolName ?? row.model ?? row.kind,
            recorded: verdict.recorded,
            shadow: verdict.shadow,
            before: verdict.before,
            after: verdict.after,
            reason: verdict.result?.reasons[0] ?? null,
          })
        }
      }),
    )

    return {
      total,
      scanned: page.length,
      verdicts,
      transitions,
      affected: affected.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      nextCursor: rows.length > BATCH ? page.at(-1)?.seq : undefined,
    }
  })

async function readPayload(orgId: string, key: string | null) {
  if (!key?.startsWith(`${orgId}/`)) return null
  const obj = await env.PAYLOADS.get(key)
  return obj ? (eventPayload.safeParse(await obj.json()).data?.input ?? null) : null
}

/** Current memberships, not the ones at the time. `*` holds the default group every member is in. */
async function groupsByUser(db: Db, orgId: string) {
  const [groups, members] = await Promise.all([
    db
      .select({ id: group.id, isDefault: group.isDefault })
      .from(group)
      .where(eq(group.orgId, orgId)),
    db
      .select({ userId: groupMember.userId, groupId: groupMember.groupId })
      .from(groupMember)
      .innerJoin(group, eq(group.id, groupMember.groupId))
      .where(eq(group.orgId, orgId)),
  ])
  const defaults = groups.filter((g) => g.isDefault).map((g) => g.id)
  const byUser = new Map<string, string[]>([['*', defaults]])
  for (const m of members) byUser.set(m.userId, [...(byUser.get(m.userId) ?? defaults), m.groupId])
  return byUser
}

async function toolTiers(db: Db, orgId: string) {
  const servers = await db
    .select({ id: mcpServer.id, tools: mcpServer.tools })
    .from(mcpServer)
    .where(eq(mcpServer.orgId, orgId))
  return (serverId: string | null, toolName: string | null) => {
    if (!serverId || !toolName) return null
    const name = toolName.slice(toolName.lastIndexOf('__') + 2)
    const tool = servers.find((s) => s.id === serverId)?.tools.find((t) => t.name === name)
    return toolTierFromAnnotations((tool as { annotations?: unknown } | undefined)?.annotations)
  }
}
