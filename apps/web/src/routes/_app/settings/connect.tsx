import { Badge, Card, CardHeader, PageHeader } from '@acl/ui'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/settings/connect')({ component: ConnectPage })

function ConnectPage() {
  return (
    <>
      <PageHeader
        title="Claude Code plugin"
        description="Deploy hy-guard to connect your team's Claude Code traffic."
      />
      <Card className="mb-4 p-5">
        <div className="mb-3 flex items-center gap-3">
          <span className="font-semibold">hy-guard</span>
          <Badge tone="warn">Backend integration pending</Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted">
          The plugin is available in this repository and runs against its mock platform. This
          dashboard's gateway does not yet support its authentication and policy protocol.
        </p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Employee experience" />
          <ul className="flex flex-col gap-2 px-5 pb-5 text-sm text-muted">
            <li>Sign in from Claude Code.</li>
            <li>Confirm sensitive actions in the plugin, with Touch ID, or in a browser.</li>
            <li>Send model and tool requests through the company gateway.</li>
          </ul>
        </Card>
        <Card>
          <CardHeader title="Administrator experience" />
          <ul className="flex flex-col gap-2 px-5 pb-5 text-sm text-muted">
            <li>Manage policy, integrations, and access here.</li>
            <li>Inspect request decisions and device/session context in Logs.</li>
            <li>Roll out the plugin after backend compatibility is verified.</li>
          </ul>
        </Card>
      </div>
      <div className="mt-4 flex gap-5 text-sm text-accent-strong">
        <a
          href="https://github.com/localhost2137/golden-sach/tree/main/claude-plugin"
          target="_blank"
          rel="noreferrer"
        >
          Plugin setup
        </a>
        <a
          href="https://github.com/localhost2137/golden-sach/blob/main/claude-plugin/docs/BACKEND_GUIDE.md"
          target="_blank"
          rel="noreferrer"
        >
          Integration guide
        </a>
      </div>
    </>
  )
}
