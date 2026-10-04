import { cn } from '@acl/ui'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import {
  Activity,
  Boxes,
  ChevronRight,
  Cpu,
  FlaskConical,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  PanelLeft,
  Plug,
  Settings,
  Users,
  UsersRound,
} from 'lucide-react'
import { type ComponentType, useState } from 'react'
import { BrandLogo } from '#/components/brand-logo.tsx'
import { authClient } from '#/lib/auth-client.ts'
import { LiveProvider } from '#/lib/live.tsx'
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
  icon: ComponentType<{ className?: string }>
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
  const [navigationOpen, setNavigationOpen] = useState(false)
  const pathname = useLocation({ select: (location) => location.pathname })
  const section = nav.find((group) =>
    group.items.some((item) =>
      item.to === '/'
        ? pathname === '/'
        : pathname === item.to || pathname.startsWith(`${item.to}/`),
    ),
  )
  const current = section?.items
    .slice()
    .reverse()
    .find((item) =>
      item.to === '/'
        ? pathname === '/'
        : pathname === item.to || pathname.startsWith(`${item.to}/`),
    )

  return (
    <LiveProvider>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div className="flex min-h-screen bg-sidebar">
        <Sidebar open={navigationOpen} onClose={() => setNavigationOpen(false)} />
        <main id="main-content" className="workspace-main min-w-0 flex-1" tabIndex={-1}>
          <header className="workspace-toolbar flex h-12 items-center justify-between gap-3 border-b border-line px-4 sm:px-7">
            <div className="flex min-w-0 items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => setNavigationOpen((open) => !open)}
                className="rounded p-1 text-muted hover:bg-panel-2 md:hidden"
                aria-label={navigationOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={navigationOpen}
                aria-controls="workspace-navigation"
              >
                <PanelLeft className="size-4" />
              </button>
              <span className="text-muted">{section?.title ?? 'Workspace'}</span>
              <ChevronRight className="size-3 text-subtle" />
              <span className="truncate font-medium">{current?.label ?? 'Overview'}</span>
            </div>
          </header>
          <div className="workspace-content mx-auto max-w-[1440px] px-4 py-7 sm:px-7 lg:px-10 lg:py-9">
            <Outlet />
          </div>
        </main>
      </div>
    </LiveProvider>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { viewer } = Route.useRouteContext()
  const navigate = useNavigate()

  return (
    <>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          aria-label="Close navigation"
          onClick={onClose}
        />
      ) : null}
      <aside
        id="workspace-navigation"
        className={cn(
          'workspace-sidebar fixed inset-y-0 left-0 z-40 flex w-[232px] shrink-0 flex-col bg-sidebar transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Link
          to="/"
          aria-label="Hack?Nah! — Overview"
          className="mx-3 mt-3 mb-5 flex h-10 items-center rounded-md px-2 hover:bg-panel-2/60"
          onClick={onClose}
        >
          <BrandLogo className="w-[112px] grayscale brightness-150" />
        </Link>
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3">
          {nav.map((section, i) => (
            <div key={section.title ?? i} className="mb-6">
              {section.title ? (
                <div className="px-2.5 pb-2 text-[11px] font-medium text-subtle">
                  {section.title}
                </div>
              ) : null}
              {section.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{
                    exact: item.to === '/' || item.to === '/settings',
                    includeSearch: false,
                  }}
                  className="group mb-0.5 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted transition-colors hover:bg-panel-2/70 hover:text-fg"
                  onClick={onClose}
                  activeProps={{ className: 'ui-nav-active bg-panel-2 !text-fg font-medium' }}
                >
                  <item.icon className="size-[15px] shrink-0 text-subtle group-[[data-status=active]]:text-fg" />
                  <span className="flex-1">{item.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel-2 text-[11px] font-medium text-fg">
              {(viewer.user.name || viewer.user.email).slice(0, 2).toUpperCase()}
            </span>
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
    </>
  )
}
