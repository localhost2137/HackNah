import { HEADER_CC_PROMPT_ID, type MessagesRequest, traceIdFor } from '@acl/shared'
import type { AppContext } from '../context.ts'
import { sessionStub } from '../do/session.ts'

/**
 * Files a model request under its trace (see `traceIdFor`) and returns the id.
 *
 * MCP calls and hooks carry no prompt, so the session remembers the trace of its latest model
 * request for them (see `SessionDO.setTrace`).
 */
export async function resolveTrace(
  c: AppContext,
  sessionId: string | null,
  body: MessagesRequest,
): Promise<string> {
  const { orgId, userId } = c.get('principal')
  const traceId = await traceIdFor({
    userId,
    sessionId,
    promptId: c.req.header(HEADER_CC_PROMPT_ID),
    body,
  })
  c.set('traceId', traceId)
  if (sessionId) {
    const loop = Array.isArray(body.tools) && body.tools.length > 0
    c.executionCtx.waitUntil(sessionStub(c.env, orgId, sessionId).setTrace(traceId, loop))
  }
  return traceId
}
