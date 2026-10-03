import { Badge, Button, Card, CardHeader, PageHeader } from '@acl/ui'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import type * as React from 'react'
import { useState } from 'react'
import { getConnectInfo } from '#/server/fns/settings.ts'

const infoQuery = queryOptions({ queryKey: ['connect-info'], queryFn: () => getConnectInfo() })

export const Route = createFileRoute('/_app/settings/connect')({
  loader: ({ context }) => context.queryClient.ensureQueryData(infoQuery),
  component: ConnectPage,
})

function ConnectPage() {
  const { data } = useQuery(infoQuery)
  const gw = data?.gatewayUrl ?? 'https://gateway.example.com'

  const settings = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: gw,
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '300000',
        DISABLE_TELEMETRY: '1',
      },
      apiKeyHelper: 'acl token',
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'acl hook pre-tool-use', timeout: 330 }],
          },
        ],
      },
      permissions: {
        deny: ['WebFetch(domain:api.anthropic.com)', 'WebFetch(domain:openrouter.ai)'],
      },
    },
    null,
    2,
  )
  const mcp = JSON.stringify(
    { mcpServers: { acl: { type: 'http', url: `${gw}/mcp`, headersHelper: 'acl headers' } } },
    null,
    2,
  )
  const hook = `#!/bin/sh
# acl hook pre-tool-use: forwards the hook payload (stdin) and prints the gateway's verdict
curl -sS --max-time 330 -X POST "${gw}/v1/acl/hooks/pre-tool-use" \\
  -H "authorization: Bearer $(acl token)" \\
  -H "x-acl-device: $(acl fingerprint)" \\
  -H "content-type: application/json" \\
  --data-binary @- || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AI Control Layer unreachable"}}'`
  const smoke = `# 1. Start a device login (what \`acl login\` does)
curl -sS -X POST ${gw}/auth/device/code -H 'content-type: application/json' \\
  -d '{"fingerprint":"<stable machine id, 16+ chars>","label":"my-laptop","platform":"linux"}'
# 2. Open verification_uri_complete in the browser and approve the code
# 3. Poll for tokens
curl -sS -X POST ${gw}/auth/device/token -H 'content-type: application/json' -d '{"device_code":"<device_code>"}'
# 4. Call the gateway with the access token and the same fingerprint
curl -sS ${gw}/auth/whoami -H "authorization: Bearer <access_token>" -H "x-acl-device: <fingerprint>"`

  return (
    <>
      <PageHeader
        title="Connect Claude Code"
        description="Every model request and tool call goes through the gateway. The ACL plugin sets this up; the snippets below show exactly what it configures."
      />
      <div className="grid gap-4">
        <Step n={1} title="Log in from the machine">
          <p>
            Run <code className="font-mono text-fg">/acl login</code> in Claude Code. It shows a
            code you approve at{' '}
            <code className="font-mono text-fg">{data?.dashboardUrl}/device</code>. The token is
            bound to this machine's fingerprint, so it is useless on another computer. A user's
            first device is trusted right away; later devices go through approval according to the
            workflow's fingerprint step.
          </p>
        </Step>
        <Step n={2} title="Route all traffic through the gateway" badge="~/.claude/settings.json">
          <p>
            <code className="font-mono text-fg">apiKeyHelper</code> returns a short-lived gateway
            token instead of a provider key. The gateway holds the OpenRouter key. Requests that
            skip the gateway have no valid credential. To stop users from editing this, ship it as
            managed settings (
            <code className="font-mono">/etc/claude-code/managed-settings.json</code> on Linux,{' '}
            <code className="font-mono">/Library/Application Support/ClaudeCode/</code> on macOS)
            and block <code className="font-mono">api.anthropic.com</code> and{' '}
            <code className="font-mono">openrouter.ai</code> at the network egress.
          </p>
          <Snippet code={settings} />
          <p>
            The plugin also sends <code className="font-mono text-fg">x-acl-device</code> on every
            request (through <code className="font-mono">ANTHROPIC_CUSTOM_HEADERS</code>). Claude
            Code's own session id ties prompts, tool calls and MCP calls together in Sessions.
          </p>
        </Step>
        <Step
          n={3}
          title="One MCP endpoint for every integration"
          badge=".mcp.json / managed-mcp.json"
        >
          <p>
            Tools from all connected servers appear as{' '}
            <code className="font-mono text-fg">mcp__acl__github__create_issue</code> and so on.{' '}
            <code className="font-mono">headersHelper</code> adds the token, the fingerprint and the
            session id. Pick the resources a session may use with{' '}
            <code className="font-mono text-fg">/acl resources</code>.
          </p>
          <Snippet code={mcp} />
        </Step>
        <Step n={4} title="Check built-in tools before they run" badge="PreToolUse hook">
          <p>
            Bash, Edit, WebFetch and other built-in tools run locally, so the hook asks the gateway
            first. Blocked calls are denied with the reason, and approvals wait until someone
            decides in the dashboard. If the gateway can't be reached, the call is denied.
          </p>
          <Snippet code={hook} />
        </Step>
        <Step n={5} title="Smoke test without the plugin">
          <Snippet code={smoke} />
        </Step>
      </div>
    </>
  )
}

function Step({
  n,
  title,
  badge,
  children,
}: {
  n: number
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] text-accent">
              {n}
            </span>
            {title}
            {badge ? <Badge className="font-mono">{badge}</Badge> : null}
          </span>
        }
      />
      <div className="flex flex-col gap-3 p-4 text-xs leading-relaxed text-muted">{children}</div>
    </Card>
  )
}

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg">
        {code}
      </pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
