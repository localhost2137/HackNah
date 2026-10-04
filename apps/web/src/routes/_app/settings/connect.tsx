import { Button, Card, CardHeader, PageHeader } from '@acl/ui'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_app/settings/connect')({ component: ConnectPage })

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-panel-2 px-3 py-2">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap">
        {text}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

function ConnectPage() {
  // The address people reach this gateway at; known only in the browser.
  const [origin, setOrigin] = useState('https://your-gateway')
  useEffect(() => setOrigin(window.location.origin), [])

  return (
    <>
      <PageHeader
        title="Claude Code plugin"
        description="Connects Claude Code on a laptop to this gateway."
      />
      <div className="grid gap-4 lg:grid-cols-2" data-tour="connect-options">
        <Card>
          <CardHeader
            title="With the script"
            description="Signs in and starts Claude Code. Nothing else to set up."
          />
          <div className="flex flex-col gap-3 px-5 pb-5">
            <Command text={`HY_PLATFORM_URL=${origin} claude-plugin/scripts/dev-claude.sh`} />
            <p className="text-xs text-muted">
              Run it from the repository. It uses its own Claude Code profile, so your normal setup
              is not touched.
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Without the script"
            description="Configuration required: three settings in your own Claude Code."
          />
          <ol className="flex list-decimal flex-col gap-3 px-5 pb-5 pl-9 text-xs text-muted">
            <li>
              Install the plugin.
              <div className="mt-1.5">
                <Command
                  text={
                    'claude plugin marketplace add ./claude-plugin\nclaude plugin install hy-guard@hy-local'
                  }
                />
              </div>
            </li>
            <li>
              Set its Platform URL (asked at install, or under /config).
              <div className="mt-1.5">
                <Command text={origin} />
              </div>
            </li>
            <li>
              Send model requests through the plugin, in <code>~/.claude/settings.json</code>.
              <div className="mt-1.5">
                <Command
                  text={`{
  "apiKeyHelper": "node \\"<plugin folder>/bridge/main.mjs\\" llm-key",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:47821",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  }
}`}
                />
              </div>
            </li>
          </ol>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="In Claude Code" />
        <dl className="grid gap-x-6 gap-y-2 px-5 pb-5 text-xs sm:grid-cols-[auto_1fr]">
          <dt className="font-mono">/hy-guard:login</dt>
          <dd className="text-muted">Sign in and register the device.</dd>
          <dt className="font-mono">/hy-guard:status</dt>
          <dd className="text-muted">Sign-in, device key and restricted tools.</dd>
          <dt className="font-mono">/mcps</dt>
          <dd className="text-muted">Choose which MCP servers this session uses.</dd>
        </dl>
      </Card>
    </>
  )
}
