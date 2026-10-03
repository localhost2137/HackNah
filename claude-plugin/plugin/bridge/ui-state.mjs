// State for the in-Claude-Code UI (the mod in hooks/ui.tsx): a JSON file the bridge
// writes and the mod polls. Calls are keyed by Claude Code's tool_use_id, so the mod
// draws each hy-guard tool row as a card with its approval state.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { readJson, uuid, writeJson } from './util.mjs';

const MAX_CALLS = 40;

function change(fn) {
  try {
    const s = readJson(config.paths.uiState, {}) ?? {};
    fn(s);
    s.updated_at = new Date().toISOString();
    writeJson(config.paths.uiState, s);
  } catch {}
}

/** Identity and posture for the status line. */
export const uiIdentity = (patch) => change((s) => Object.assign(s, patch));

/** One tool call's card. `state`: running | waiting_confirm | waiting_touchid | waiting_browser | done | blocked */
export function uiCall(toolUseId, patch) {
  if (!toolUseId) return;
  change((s) => {
    s.calls ??= {};
    s.calls[toolUseId] = { ...s.calls[toolUseId], ...patch, at: new Date().toISOString() };
    const ids = Object.keys(s.calls);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CALLS))) delete s.calls[id];
  });
}

/** A one-off toast ("✓ Approved with Touch ID", "⛔ blocked: EDR alert"). */
export const uiToast = (kind, text) => change((s) => (s.last_event = { id: uuid(), kind, text, at: new Date().toISOString() }));

/**
 * A mod has no plugin data folder; leave a pointer to ours inside the plugin folder.
 * (In dev the mod reads HY_DATA_DIR from the environment first.)
 */
export function writeDataDirPointer() {
  try {
    mkdirSync(join(config.pluginRoot, '.runtime'), { recursive: true });
    writeFileSync(join(config.pluginRoot, '.runtime', 'data-dir'), config.dataDir);
  } catch {}
}
