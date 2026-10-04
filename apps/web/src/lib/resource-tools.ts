/** "GitHub: 3 tools", "Jira: all tools" for each server a resource holds tools from. */
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
