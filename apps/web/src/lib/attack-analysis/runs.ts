import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAnalysisRun, listAnalysisRuns } from '#/server/fns/attack-analysis.ts'
import { catalogVersion } from './catalog.ts'
import type { AnalysisRun } from './run-types.ts'

export type { AnalysisRun } from './run-types.ts'

/** Small persisted index is refreshed independently of the large R2 result payloads. */
export function useAnalysisRuns(userId: string) {
  const client = useQueryClient()
  const queryKey = ['attack-analysis-runs', userId, catalogVersion]
  const query = useQuery({
    queryKey,
    queryFn: () => listAnalysisRuns(),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  })
  return {
    runs: query.error ? [] : (query.data?.runs ?? []),
    revision: query.error ? undefined : query.data?.revision,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refetch,
    savedRun: async (run: AnalysisRun) => {
      client.setQueryData(
        ['attack-analysis-run', userId, catalogVersion, run.revision, run.id],
        run,
      )
      await client.invalidateQueries({ queryKey })
    },
  }
}

export function useAnalysisRun(
  userId: string,
  revision: number | undefined,
  id: string | undefined,
) {
  return useQuery({
    queryKey: ['attack-analysis-run', userId, catalogVersion, revision, id],
    queryFn: async (): Promise<AnalysisRun | null> => {
      const json = await getAnalysisRun({ data: { id: id! } })
      return json ? (JSON.parse(json) as AnalysisRun) : null
    },
    enabled: Boolean(id) && revision !== undefined,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })
}
