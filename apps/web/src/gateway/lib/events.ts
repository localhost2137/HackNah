import type { EventPayload, GatewayEvent } from '@acl/shared'
import { approvalsStub } from '../do/approvals.ts'

/** Raw bodies are capped so one huge prompt can't blow up storage or memory. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

export function payloadKey(event: Pick<GatewayEvent, 'orgId' | 'createdAt' | 'id'>): string {
  return `${event.orgId}/${event.createdAt.slice(0, 10)}/${event.id}.json`
}

/**
 * Persists one event: the payload to R2, metadata to the queue (the consumer writes D1),
 * and a copy to the org's live stream.
 */
export async function recordEvent(
  env: Env,
  event: GatewayEvent,
  payload: EventPayload | null,
): Promise<void> {
  const tasks: Promise<unknown>[] = []
  if (payload) {
    let body = JSON.stringify(payload)
    if (body.length > MAX_PAYLOAD_BYTES) {
      body = JSON.stringify({ ...payload, request: '[truncated]', response: '[truncated]' })
    }
    event.payloadKey = payloadKey(event)
    tasks.push(
      env.PAYLOADS.put(event.payloadKey, body, {
        httpMetadata: { contentType: 'application/json' },
      }),
    )
  }
  await Promise.all(tasks)
  await Promise.allSettled([
    env.EVENTS.send(event),
    approvalsStub(env, event.orgId).publish({ type: 'event', event }),
  ])
}
