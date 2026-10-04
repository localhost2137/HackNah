import { createServerFn } from '@tanstack/react-start'
import {
  getAnalysisRunInput,
  getAnalysisRunService,
  listAnalysisRunsService,
  runAnalysisInput,
  runAnalysisService,
} from '../attack-analysis-service.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

export const listAnalysisRuns = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler((args) => listAnalysisRunsService({ ...args, context: { ...args.context, env } }))

export const getAnalysisRun = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(getAnalysisRunInput)
  .handler((args) => getAnalysisRunService({ ...args, context: { ...args.context, env } }))

export const runAnalysis = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(runAnalysisInput)
  .handler((args) => runAnalysisService({ ...args, context: { ...args.context, env } }))
