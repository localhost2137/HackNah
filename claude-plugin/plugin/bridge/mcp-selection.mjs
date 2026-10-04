// Which company MCP servers this session uses. The person picks them with /mcps in Claude Code
// (hooks/ui.tsx), which writes the servers that are switched off to a file; the bridge hides
// their tools and refuses calls to them. Everything is on when a session starts.

import { unwatchFile, watchFile } from 'node:fs';
import { config } from './config.mjs';
import { readJson } from './util.mjs';

/** Gateway tools are named `<server>__<tool>`; anything else belongs to the gateway itself. */
export const serverOf = (tool) => {
  const at = tool.indexOf('__');
  return at > 0 ? tool.slice(0, at) : 'gateway';
};

export function switchedOff() {
  const off = readJson(config.paths.mcpSelection, null)?.off;
  return new Set(Array.isArray(off) ? off.filter((s) => typeof s === 'string') : []);
}

/** `[{ name, tools }]` for the picker, in name order. */
export function serversOf(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(serverOf(tool.name), (counts.get(serverOf(tool.name)) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, tools: count })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Calls `onChange` when the selection file changes. Returns a function that stops watching. */
export function watchSelection(onChange) {
  watchFile(config.paths.mcpSelection, { interval: 500 }, onChange);
  return () => unwatchFile(config.paths.mcpSelection, onChange);
}
