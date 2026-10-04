import type { ActiveGuardrail } from '@acl/shared'
import type { EventResult, Persona } from './replay.ts'

export type AnalysisRun = {
  id: string
  datasetId: string
  revision: number
  at: string
  catalogVersion: string
  persona: Persona
  groupNames: string[]
  guardrails: ActiveGuardrail[]
  results: EventResult[]
}

export type RunSummary = Pick<
  AnalysisRun,
  'id' | 'datasetId' | 'revision' | 'at' | 'catalogVersion'
> & {
  total: number
  correct: number
}
