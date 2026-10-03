import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Sheet,
  Switch,
} from '@acl/ui'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRound, Link2, Plug, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { z } from 'zod'
import { FormError } from '#/components/auth-shell.tsx'
import { timeAgo } from '#/lib/format.ts'
import { type McpPreset, mcpPresets } from '#/lib/mcp-presets.ts'
import {
  deleteMcpServer,
  disconnectCredential,
  listMcpServers,
  refreshMcpTools,
  saveMcpServer,
  setBearerCredential,
  setMcpEnabled,
} from '#/server/fns/integrations.ts'

const serversQuery = queryOptions({ queryKey: ['mcp-servers'], queryFn: () => listMcpServers() })

export const Route = createFileRoute('/_app/integrations')({
  validateSearch: z.object({ connected: z.string().optional(), error: z.string().optional() }),
  loader: ({ context }) => context.queryClient.ensureQueryData(serversQuery),
  component: IntegrationsPage,
})

type Server = Awaited<ReturnType<typeof listMcpServers>>[number]
type Draft = {
  id?: string
  preset?: string
  name: string
  slug: string
  url: string
  authType: 'none' | 'bearer' | 'oauth2'
  credentialMode: 'org' | 'user'
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  hasSecret?: boolean
}

function fromPreset(p: McpPreset): Draft {
  return {
    preset: p.id,
    name: p.name,
    slug: p.slug,
    url: p.url,
    authType: p.authType,
    credentialMode: p.credentialMode,
    authorizeUrl: p.oauth?.authorizeUrl ?? '',
    tokenUrl: p.oauth?.tokenUrl ?? '',
    clientId: '',
    clientSecret: '',
    scopes: p.oauth?.scopes.join(' ') ?? '',
  }
}

function fromServer(s: Server): Draft {
  return {
    id: s.id,
    preset: s.preset ?? undefined,
    name: s.name,
    slug: s.slug,
    url: s.url,
    authType: s.authType,
    credentialMode: s.credentialMode,
    authorizeUrl: s.oauth?.authorizeUrl ?? '',
    tokenUrl: s.oauth?.tokenUrl ?? '',
    clientId: s.oauth?.clientId ?? '',
    clientSecret: '',
    scopes: s.oauth?.scopes.join(' ') ?? '',
    hasSecret: s.oauth?.hasSecret,
  }
}

function IntegrationsPage() {
  const { isAdmin } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const { data: servers = [] } = useQuery(serversQuery)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tokenFor, setTokenFor] = useState<Server | null>(null)
  const [token, setToken] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveMcpServer({
        data: {
          id: d.id,
          preset: d.preset,
          name: d.name,
          slug: d.slug,
          url: d.url,
          authType: d.authType,
          credentialMode: d.credentialMode,
          oauth:
            d.authType === 'oauth2'
              ? {
                  authorizeUrl: d.authorizeUrl,
                  tokenUrl: d.tokenUrl,
                  clientId: d.clientId,
                  clientSecret: d.clientSecret || undefined,
                  scopes: d.scopes.split(/[\s,]+/).filter(Boolean),
                }
              : undefined,
        },
      }),
    onSuccess: async () => {
      setDraft(null)
      await invalidate()
    },
  })
  const saveToken = useMutation({
    mutationFn: () => setBearerCredential({ data: { serverId: tokenFor!.id, token } }),
    onSuccess: async () => {
      setTokenFor(null)
      setToken('')
      await invalidate()
    },
  })
  const disconnect = useMutation({
    mutationFn: (args: { serverId: string; shared: boolean }) =>
      disconnectCredential({ data: args }),
    onSuccess: invalidate,
  })
  const refresh = useMutation({
    mutationFn: (serverId: string) => refreshMcpTools({ data: { serverId } }),
    onSuccess: invalidate,
  })
  const toggle = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) => setMcpEnabled({ data: args }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteMcpServer({ data: { id } }),
    onSuccess: invalidate,
  })

  return (
    <>
      <PageHeader
        title="Integrations"
        description="MCP servers behind the gateway. Claude Code connects to a single endpoint; credentials stay encrypted in the gateway and never reach the laptop."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={() => setDraft(fromPreset(mcpPresets[0]!))}>
              <Plus /> Add MCP server
            </Button>
          ) : null
        }
      />
      {search.connected || search.error ? (
        <div
          className={`mb-4 flex items-center justify-between rounded-md px-3 py-2 text-xs ${search.error ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}`}
        >
          {search.error ? search.error : `Connected ${search.connected}.`}
          <button type="button" onClick={() => navigate({ search: {} })}>
            ✕
          </button>
        </div>
      ) : null}

      {servers.length === 0 ? (
        <Card>
          <EmptyState
            title="No MCP servers"
            description="Add GitHub, Jira or any MCP server that speaks Streamable HTTP."
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {servers.map((s) => {
            const shared = s.credentialMode === 'org'
            const cred = shared ? s.orgCredential : s.myCredential
            const connected = s.authType === 'none' || Boolean(cred)
            return (
              <Card key={s.id} className={s.enabled ? '' : 'opacity-60'}>
                <div className="flex items-start gap-3 px-4 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
                    <Plug className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold">{s.name}</span>
                      <Badge className="font-mono">{s.slug}__*</Badge>
                      {connected ? (
                        <Badge tone="ok" dot>
                          Connected
                        </Badge>
                      ) : (
                        <Badge tone="warn" dot>
                          Not connected
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-subtle">{s.url}</div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                      <span>
                        {s.authType === 'oauth2'
                          ? 'OAuth'
                          : s.authType === 'bearer'
                            ? 'API token'
                            : 'No auth'}
                      </span>
                      <span>{shared ? 'Shared org credential' : 'Per-user credential'}</span>
                      <span>
                        {s.toolCount} tools
                        {s.toolsRefreshedAt ? ` · refreshed ${timeAgo(s.toolsRefreshedAt)}` : ''}
                      </span>
                      {cred?.updatedAt ? (
                        <span>credential set {timeAgo(cred.updatedAt)}</span>
                      ) : null}
                    </div>
                  </div>
                  {isAdmin ? (
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(enabled) => toggle.mutate({ id: s.id, enabled })}
                      label="Enabled"
                    />
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
                  {s.authType === 'oauth2' && (!shared || isAdmin) ? (
                    <a href={`/api/oauth/start/${s.id}`}>
                      <Button size="sm" variant={connected ? 'secondary' : 'primary'}>
                        <Link2 />{' '}
                        {connected
                          ? 'Reconnect'
                          : shared
                            ? 'Connect org account'
                            : 'Connect my account'}
                      </Button>
                    </a>
                  ) : null}
                  {s.authType === 'bearer' && (!shared || isAdmin) ? (
                    <Button
                      size="sm"
                      variant={connected ? 'secondary' : 'primary'}
                      onClick={() => setTokenFor(s)}
                    >
                      <KeyRound /> {connected ? 'Replace token' : 'Add token'}
                    </Button>
                  ) : null}
                  {cred && (!shared || isAdmin) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => disconnect.mutate({ serverId: s.id, shared })}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!connected || refresh.isPending}
                    onClick={() => refresh.mutate(s.id)}
                  >
                    <RefreshCw
                      className={
                        refresh.isPending && refresh.variables === s.id ? 'animate-spin' : ''
                      }
                    />{' '}
                    Refresh tools
                  </Button>
                  {isAdmin ? (
                    <div className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setDraft(fromServer(s))}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          confirm(`Delete ${s.name}? Its resources are deleted too.`) &&
                          remove.mutate(s.id)
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>
            )
          })}
        </div>
      )}
      <FormError message={refresh.error?.message ?? disconnect.error?.message ?? null} />

      <Sheet
        open={draft !== null}
        onOpenChange={(o) => !o && setDraft(null)}
        title={draft?.id ? `Edit ${draft.name}` : 'Add MCP server'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              Save
            </Button>
          </>
        }
      >
        {draft ? (
          <ServerForm draft={draft} onChange={setDraft} error={save.error?.message ?? null} />
        ) : null}
      </Sheet>

      <Dialog
        open={tokenFor !== null}
        onOpenChange={(o) => !o && setTokenFor(null)}
        title={`${tokenFor?.name ?? ''} token`}
        description={
          tokenFor?.credentialMode === 'org'
            ? 'Shared by everyone with access.'
            : 'Used only for your requests.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setTokenFor(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={token.length < 8 || saveToken.isPending}
              onClick={() => saveToken.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Token" hint="Encrypted with AES-256-GCM before it is stored.">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="mt-3">
          <FormError message={saveToken.error?.message ?? null} />
        </div>
      </Dialog>
    </>
  )
}

function ServerForm({
  draft,
  onChange,
  error,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  error: string | null
}) {
  const preset = mcpPresets.find((p) => p.id === draft.preset)
  return (
    <div className="flex flex-col gap-4">
      {!draft.id ? (
        <Field label="Start from">
          <Select
            value={draft.preset}
            onChange={(e) => onChange(fromPreset(mcpPresets.find((p) => p.id === e.target.value)!))}
          >
            {mcpPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {preset ? (
        <p className="rounded-md bg-panel-2 px-3 py-2 text-xs text-muted">{preset.help}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Tool prefix" hint={`Tools appear as ${draft.slug || 'prefix'}__tool_name`}>
          <Input
            value={draft.slug}
            onChange={(e) => onChange({ ...draft, slug: e.target.value.toLowerCase() })}
          />
        </Field>
      </div>
      <Field label="MCP endpoint (Streamable HTTP)">
        <Input value={draft.url} onChange={(e) => onChange({ ...draft, url: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Authentication">
          <Select
            value={draft.authType}
            onChange={(e) => onChange({ ...draft, authType: e.target.value as Draft['authType'] })}
          >
            <option value="oauth2">OAuth 2.0</option>
            <option value="bearer">API token</option>
            <option value="none">None</option>
          </Select>
        </Field>
        <Field label="Credential">
          <Select
            value={draft.credentialMode}
            onChange={(e) =>
              onChange({ ...draft, credentialMode: e.target.value as Draft['credentialMode'] })
            }
          >
            <option value="user">Each user connects their own</option>
            <option value="org">One shared org credential</option>
          </Select>
        </Field>
      </div>
      {draft.authType === 'oauth2' ? (
        <>
          <Field label="Authorize URL">
            <Input
              value={draft.authorizeUrl}
              onChange={(e) => onChange({ ...draft, authorizeUrl: e.target.value })}
            />
          </Field>
          <Field label="Token URL">
            <Input
              value={draft.tokenUrl}
              onChange={(e) => onChange({ ...draft, tokenUrl: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Client ID">
              <Input
                value={draft.clientId}
                onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
              />
            </Field>
            <Field
              label="Client secret"
              hint={draft.hasSecret ? 'Leave empty to keep the stored secret' : undefined}
            >
              <Input
                type="password"
                value={draft.clientSecret}
                onChange={(e) => onChange({ ...draft, clientSecret: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Scopes" hint="Space separated">
            <Input
              value={draft.scopes}
              onChange={(e) => onChange({ ...draft, scopes: e.target.value })}
            />
          </Field>
          <p className="text-[11px] text-subtle">
            Callback URL to register with the provider:{' '}
            <span className="font-mono text-muted">
              {typeof window === 'undefined' ? '' : window.location.origin}/api/oauth/callback
            </span>
          </p>
        </>
      ) : null}
      <FormError message={error} />
    </div>
  )
}
