import { policyGraph } from '@acl/shared'
import { Card, EmptyState, PageHeader, Select } from '@acl/ui'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { ShadowImpact } from '#/components/workflow/shadow-impact.tsx'
import { getWorkflow } from '#/server/fns/workflow.ts'

const workflowQuery = (workflowId: string) =>
  queryOptions({
    queryKey: ['workflow', workflowId],
    queryFn: () => getWorkflow({ data: { workflowId } }),
  })

export const Route = createFileRoute('/_app/workflows/$workflowId_/impact')({
  validateSearch: z.object({ version: z.number().optional() }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(workflowQuery(params.workflowId)),
  component: ImpactPage,
})

function ImpactPage() {
  const { workflowId } = Route.useParams()
  const { version } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(workflowQuery(workflowId))
  if (!data) return null

  const choices = data.versions.flatMap((v) => {
    const parsed = policyGraph.safeParse(v.definition)
    return parsed.success ? [{ ...v, graph: parsed.data }] : []
  })
  const selected =
    choices.find((v) => v.version === version) ??
    choices.find((v) => v.id === data.draft?.id) ??
    choices.find((v) => v.id === data.published?.id) ??
    choices[0]

  return (
    <>
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId }}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> Back to the editor
      </Link>
      <PageHeader
        title={`Impact of ${data.workflow.name}`}
        description="Replays a saved version on past requests, including failed ones, without publishing it. Other workflows keep the outcome they reached at the time."
        actions={
          choices.length > 0 ? (
            <Select
              aria-label="Version"
              className="w-44"
              value={selected?.version}
              onChange={(e) =>
                navigate({ search: { version: Number(e.target.value) }, replace: true })
              }
            >
              {choices.map((v) => (
                <option key={v.id} value={v.version}>
                  v{v.version} · {v.id === data.published?.id ? 'live' : v.status}
                </option>
              ))}
            </Select>
          ) : null
        }
      />
      {selected ? (
        <ShadowImpact key={selected.id} workflowId={workflowId} graph={selected.graph} />
      ) : (
        <Card>
          <EmptyState
            title="Nothing saved yet"
            description="Save a draft in the editor to see how it would have handled past traffic."
          />
        </Card>
      )}
    </>
  )
}
