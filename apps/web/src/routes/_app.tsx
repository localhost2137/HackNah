import { cn } from '@acl/ui'
import { createFileRoute, Link, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import {
  Activity,
  Boxes,
  Cpu,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plug,
  Settings,
  Users,
  UsersRound,
} from 'lucide-react'
import type * as React from 'react'
import { BrandLogo } from '#/components/brand-logo.tsx'
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
      { to: '/guardrails', label: 'Guardrails', icon: ListChecks },
      { to: '/limits', label: 'Limits', icon: Gauge },
      { to: '/models', label: 'Models', icon: Cpu },
      { to: '/datasets', label: 'Attack analysis', icon: FlaskConical },
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
      <div className="flex min-h-screen bg-bg">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1400px] px-6 py-7 lg:px-9 lg:py-8">
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
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-[#0a1421]">
      <Link
        to="/"
        aria-label="Hack?Nah! — Overview"
        className="mx-4 mt-4 mb-5 block rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#cefa52]"
      >
        <BrandLogo className="w-full" />
      </Link>
      <nav className="flex-1 overflow-y-auto px-3">
        {nav.map((section, i) => (
          <div key={section.title ?? i} className="mb-5">
            {section.title ? (
              <div className="px-2 pb-2 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
                {section.title}
              </div>
            ) : null}
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/' || item.to === '/settings' }}
                className="group mb-0.5 flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-panel-2/70 hover:text-fg"
                activeProps={{ className: 'bg-accent-soft !text-accent-strong' }}
              >
                <item.icon className="size-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-4">
        <div className="flex items-center gap-2.5">
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
