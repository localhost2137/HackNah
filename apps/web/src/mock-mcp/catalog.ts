import { z } from 'zod'

export const providers = ['datadog', 'confluence', 'jira'] as const
export type Provider = (typeof providers)[number]
export const mockToken = (provider: Provider) => `local-demo-${provider}-token`
const text = z.string().trim().min(1).max(1000)
const paging = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^\d+$/).optional(),
}
const query = { query: z.string().max(500).default('') }
const tools = {
  get_environment: {
    providers,
    description:
      'Read the fictional Aurelius Securities dataset clock, service inventory and incident drill context. All data is synthetic.',
    schema: z.object({}).strict(),
  },
  search_logs: {
    providers: ['datadog'],
    description:
      'Search synthetic Datadog logs. Free-text terms are ANDed; supported facets: service:, status:, env:, trace_id:. Use from/to ISO timestamps and pagination. This is a subset, not the full Datadog query language.',
    schema: z
      .object({
        ...query,
        service: text.optional(),
        status: z.enum(['info', 'warn', 'error']).optional(),
        env: z.enum(['prod', 'staging']).optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        ...paging,
      })
      .strict(),
  },
  get_trace: {
    providers: ['datadog'],
    description:
      'Get an end-to-end synthetic APM trace, including spans, duration, errors, deployment and related log IDs.',
    schema: z.object({ trace_id: text }).strict(),
  },
  list_monitors: {
    providers: ['datadog'],
    description:
      'List monitor thresholds, observed values, ownership, alert timelines and linked runbooks.',
    schema: z
      .object({
        service: text.optional(),
        state: z.enum(['Alert', 'Warn', 'OK']).optional(),
        ...paging,
      })
      .strict(),
  },
  get_service_health: {
    providers: ['datadog'],
    description:
      'Get service SLOs, dependencies, current health and comparison with pre-deployment baselines.',
    schema: z.object({ service: text }).strict(),
  },
  list_deployments: {
    providers: ['datadog'],
    description:
      'List deployment versions, rollout times, changed configuration and rollback references.',
    schema: z.object({ service: text.optional(), ...paging }).strict(),
  },
  search_pages: {
    providers: ['confluence'],
    description:
      'Search runbooks, architecture, postmortems and operational policies. Free text is ANDed. Results include excerpts, versions and review dates; fetch the page for full instructions.',
    schema: z.object({ ...query, space: text.optional(), ...paging }).strict(),
  },
  get_page: {
    providers: ['confluence'],
    description:
      'Read a complete synthetic Confluence page with Markdown, owner, review status and related pages/issues.',
    schema: z.object({ page_id: text }).strict(),
  },
  search_issues: {
    providers: ['jira'],
    description:
      'Search synthetic Jira issues by text and explicit filters. This tool does not accept JQL. Results omit full discussion; use get_issue for evidence and decisions.',
    schema: z
      .object({
        ...query,
        project: z.enum(['PAY', 'RISK', 'PLAT']).optional(),
        status: z.enum(['Open', 'Investigating', 'Mitigating', 'Resolved', 'Done']).optional(),
        priority: z.enum(['P1', 'P2', 'P3']).optional(),
        ...paging,
      })
      .strict(),
  },
  get_issue: {
    providers: ['jira'],
    description: 'Read a Jira issue, description, comments, incident timeline and linked evidence.',
    schema: z.object({ issue_key: text }).strict(),
  },
  create_issue: {
    providers: ['jira'],
    description:
      'Persist a new LOCAL MOCK Jira issue. No real Jira is contacted. Repeating the same idempotency_key returns the original issue; conflicting reuse fails.',
    schema: z
      .object({
        project: z.enum(['PAY', 'RISK', 'PLAT']),
        summary: z.string().trim().min(5).max(180),
        description: z.string().trim().min(10).max(12000),
        priority: z.enum(['P1', 'P2', 'P3']).default('P2'),
        labels: z.array(z.string().min(1).max(60)).max(12).default([]),
        related_issue: text.optional(),
        idempotency_key: z.string().min(8).max(100),
      })
      .strict(),
    write: true,
  },
  add_comment: {
    providers: ['jira'],
    description:
      'Persist a comment on a LOCAL MOCK Jira issue. Idempotency prevents duplicates on retries. Author is always the shared integration bot, never a claimed employee.',
    schema: z
      .object({
        issue_key: text,
        body: z.string().trim().min(1).max(8000),
        idempotency_key: z.string().min(8).max(100),
      })
      .strict(),
    write: true,
  },
} satisfies Record<
  string,
  { providers: readonly string[]; description: string; schema: z.ZodType; write?: boolean }
>
export type ToolName = keyof typeof tools
export function toolDefinition(provider: Provider, name: string) {
  const tool = tools[name as ToolName]
  return tool && (tool.providers as readonly string[]).includes(provider) ? tool : undefined
}
export function listMockTools(provider: Provider) {
  return Object.entries(tools)
    .filter(([, t]) => (t.providers as readonly string[]).includes(provider))
    .map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema, { io: 'input' }),
      annotations: {
        readOnlyHint: !('write' in t),
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }))
}
