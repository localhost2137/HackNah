import { queryOptions } from '@tanstack/react-query'
import { getDatasetRows, listDatasets } from '#/server/fns/datasets.ts'

export const datasetsQuery = queryOptions({
  queryKey: ['datasets'],
  queryFn: () => listDatasets(),
})

export const datasetRowsQuery = (slug: string) =>
  queryOptions({
    queryKey: ['dataset-rows', slug],
    queryFn: () => getDatasetRows({ data: { slug } }),
    staleTime: Number.POSITIVE_INFINITY,
  })
