import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from '../middleware.ts'
import {
  createWorkflowInput,
  createWorkflowService,
  deleteWorkflowInput,
  deleteWorkflowService,
  discardDraftInput,
  discardDraftService,
  getWorkflowInput,
  getWorkflowService,
  listWorkflowsService,
  publishDraftInput,
  publishDraftService,
  reorderWorkflowsInput,
  reorderWorkflowsService,
  saveDraftInput,
  saveDraftService,
  updateWorkflowInput,
  updateWorkflowService,
} from '../workflow-service.ts'

export { findWorkflow } from '../workflow-service.ts'

export const listWorkflows = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(listWorkflowsService)

export const createWorkflow = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(createWorkflowInput)
  .handler(createWorkflowService)

export const updateWorkflow = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(updateWorkflowInput)
  .handler(updateWorkflowService)

export const reorderWorkflows = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(reorderWorkflowsInput)
  .handler(reorderWorkflowsService)

export const deleteWorkflow = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(deleteWorkflowInput)
  .handler(deleteWorkflowService)

export const getWorkflow = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(getWorkflowInput)
  .handler(getWorkflowService)

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
