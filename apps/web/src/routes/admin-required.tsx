import { Button } from '@acl/ui'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthShell } from '#/components/auth-shell.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { getViewer } from '#/server/fns/viewer.ts'

export const Route = createFileRoute('/admin-required')({
  beforeLoad: async () => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: '/login' })
    return { viewer }
  },
  component: AdminRequired,
})

function AdminRequired() {
  const { viewer } = Route.useRouteContext()
  const admins = viewer.orgs.filter((org) => org.role === 'admin')
  return (
    <AuthShell
      title="Administrator access required"
      subtitle="This dashboard is for organization admins. Use Claude Code with the hy-guard plugin for agent access."
    >
      <div className="flex flex-col gap-3">
        {admins.map((org) => (
          <Button
            key={org.id}
            onClick={async () => {
              await authClient.organization.setActive({ organizationId: org.id })
              window.location.assign('/')
            }}
          >
            Open {org.name}
          </Button>
        ))}
        <Button
          onClick={async () => {
            await authClient.signOut()
            window.location.assign('/login')
          }}
        >
          Sign out
        </Button>
      </div>
    </AuthShell>
  )
}
