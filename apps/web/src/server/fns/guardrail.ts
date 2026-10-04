import { createServerFn } from '@tanstack/react-start'
import {
  createGuardrailInput,
  createGuardrailService,
  deleteGuardrailInput,
  deleteGuardrailService,
  discardDraftInput,
  discardDraftService,
  getGuardrailInput,
  getGuardrailService,
  listGuardrailsService,
  publishDraftInput,
  publishDraftService,
  reorderGuardrailsInput,
  reorderGuardrailsService,
  saveDraftInput,
  saveDraftService,
  updateGuardrailInput,
  updateGuardrailService,
} from '../guardrail-service.ts'
import { adminMiddleware } from '../middleware.ts'

export { findGuardrail } from '../guardrail-service.ts'

export const listGuardrails = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(listGuardrailsService)

export const createGuardrail = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createGuardrailInput)
  .handler(createGuardrailService)

export const updateGuardrail = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateGuardrailInput)
  .handler(updateGuardrailService)

export const reorderGuardrails = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(reorderGuardrailsInput)
  .handler(reorderGuardrailsService)

export const deleteGuardrail = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(deleteGuardrailInput)
  .handler(deleteGuardrailService)

export const getGuardrail = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(getGuardrailInput)
  .handler(getGuardrailService)

export const saveDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(saveDraftInput)
  .handler(saveDraftService)

export const publishDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(publishDraftInput)
  .handler(publishDraftService)

export const discardDraft = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(discardDraftInput)
  .handler(discardDraftService)
