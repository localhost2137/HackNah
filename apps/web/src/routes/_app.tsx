import { cn } from '@acl/ui'
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  Boxes,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
} from 'lucide-react'
import type * as React from 'react'
import { authClient } from '#/lib/auth-client.ts'
import { LiveProvider, useLive } from '#/lib/live.tsx'
import { getViewer } from '#/server/fns/viewer.ts'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: '/login', search: { redirect: location.href } })
    if (viewer.role !== 'admin') throw redirect({ to: '/admin-required' })
    return { viewer, isAdmin: true }
  },
  component: AppLayout,
})

type NavItem = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const nav: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/events', label: 'Logs', icon: Activity },
    ],
  },
  {
    title: 'Policy',
    items: [
      { to: '/workflow', label: 'Workflow', icon: ListChecks },
      { to: '/rate-limits', label: 'Rate limits', icon: Gauge },
    ],
  },
  {
    title: 'Access',
    items: [
      { to: '/integrations', label: 'Integrations', icon: Plug },
      { to: '/access/resources', label: 'Resources', icon: Boxes },
      { to: '/access/groups', label: 'Groups', icon: UsersRound },
      { to: '/access/members', label: 'Members', icon: Users },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings },
      { to: '/settings/connect', label: 'Claude Code plugin', icon: KeyRound },
    ],
  },
]

function AppLayout() {
  return (
    <LiveProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1400px] px-8 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </LiveProvider>
  )
}

function Sidebar() {
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate()
  const live = useLive()

  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="flex size-6 items-center justify-center rounded bg-accent text-white">
          <ShieldCheck className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold tracking-tight">AI Control Layer</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {nav.map((section, i) => (
          <div key={section.title ?? i} className="mb-3">
            {section.title ? (
              <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-subtle uppercase">
                {section.title}
              </div>
            ) : null}
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/' || item.to === '/settings' }}
                className="group flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted hover:bg-panel-2 hover:text-fg"
                activeProps={{ className: 'bg-panel-2 !text-fg' }}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2">
          <span
            className={cn('size-2 rounded-full', live.connected ? 'bg-ok' : 'bg-subtle')}
            title={live.connected ? 'Live updates connected' : 'Live updates offline'}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-fg">{viewer.user.name}</div>
            <div className="truncate text-[11px] text-subtle">{viewer.user.email}</div>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            aria-label="Sign out"
            onClick={async () => {
              await authClient.signOut()
              await navigate({ to: '/login' })
            }}
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}
