import { Badge, Input } from '@acl/ui'
import { useState } from 'react'

export type PickerServer = { id: string; name: string; enabled: boolean; tools: { name: string }[] }

/**
 * Picks MCP tools across servers. `value` maps a server id to tool name patterns; `['*']` is
 * every tool of that server, including ones it adds later. A server without an entry is left out.
 */
export function McpToolPicker({
  servers,
  value,
  onChange,
}: {
  servers: PickerServer[]
  value: Record<string, string[]>
  onChange: (value: Record<string, string[]>) => void
}) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const set = (id: string, tools: string[] | null) => {
    const { [id]: _, ...rest } = value
    onChange(tools ? { ...rest, [id]: tools } : rest)
  }
  const total = servers.reduce((n, s) => n + s.tools.length, 0)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted">MCP servers and tools</span>
        {total > 8 ? (
          <Input
            aria-label="Search tools"
            placeholder={`Search ${total} tools`}
            className="h-7 w-48"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {servers.map((s) => {
          const tools = value[s.id]
          const included = tools !== undefined
          const all = tools?.includes('*') ?? false
          // Patterns that do not name a known tool (e.g. `get_*`) are kept and shown as is.
          const names = [
            ...s.tools.map((t) => t.name),
            ...(tools ?? []).filter((t) => t !== '*' && !s.tools.some((x) => x.name === t)),
          ]
          const shown = query ? names.filter((n) => n.toLowerCase().includes(query)) : names
          // While searching, servers without a matching tool step out of the way.
          if (query && shown.length === 0 && !s.name.toLowerCase().includes(query)) return null
          const picked = all ? s.tools.length : (tools ?? []).length
          return (
            <li key={s.id} className="flex flex-col gap-2 px-3 py-2">
              <div className="flex items-center gap-3">
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={(e) => set(s.id, e.target.checked ? ['*'] : null)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-xs">{s.name}</span>
                  {!s.enabled ? <Badge>disabled</Badge> : null}
                </label>
                {included ? (
                  <>
                    <span className="font-mono text-[11px] text-subtle">
                      {all ? 'all' : picked} / {s.tools.length}
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-accent-strong hover:underline"
                      onClick={() => set(s.id, all ? [] : ['*'])}
                    >
                      {all ? 'Pick tools' : 'All tools'}
                    </button>
                  </>
                ) : null}
              </div>
              {(included && !all) || (query && shown.length > 0 && !all) ? (
                names.length === 0 ? (
                  <p className="pl-7 text-[11px] text-subtle">
                    Tool list not loaded yet. Refresh tools on the Integrations page.
                  </p>
                ) : (
                  <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto pl-7">
                    {shown.map((name) => {
                      const on = tools?.includes(name) ?? false
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            set(
                              s.id,
                              on
                                ? (tools ?? []).filter((t) => t !== name)
                                : [...(tools ?? []), name],
                            )
                          }
                        >
                          <Badge tone={on ? 'accent' : 'neutral'} className="font-mono">
                            {name}
                          </Badge>
                        </button>
                      )
                    })}
                    {shown.length === 0 ? (
                      <span className="text-[11px] text-subtle">No tool matches the search.</span>
                    ) : null}
                  </div>
                )
              ) : null}
            </li>
          )
        })}
        {servers.length === 0 ? (
          <li className="px-3 py-3 text-xs text-muted">No MCP servers connected</li>
        ) : null}
      </ul>
      <span className="text-[11px] text-subtle">
        Tick a server to include it. "All tools" also covers tools the server adds later; "Pick
        tools" lets you choose them one by one.
      </span>
    </div>
  )
}

/** "GitHub: 3 tools · Jira: all tools", for tables. */
export function toolSummary(
  tools: Record<string, string[]>,
  servers: { id: string; name: string }[],
): string[] {
  return Object.entries(tools).map(([id, patterns]) => {
    const name = id === '*' ? 'Every server' : (servers.find((s) => s.id === id)?.name ?? id)
    return patterns.includes('*')
      ? `${name}: all tools`
      : `${name}: ${patterns.length} ${patterns.length === 1 ? 'tool' : 'tools'}`
  })
}
