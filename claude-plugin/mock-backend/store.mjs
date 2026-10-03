// In-memory state, persisted to .data/state.json so devices survive restarts.
// Each collection maps to a table the real backend needs (BACKEND_CONTRACT.md §7).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.env.MOCK_STATE_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '.data', 'state.json');

const empty = () => ({
  users: {}, // id -> { id, email, name }
  devices: {}, // id -> device record
  auth_requests: {}, // id -> pending /authorize request (short-lived)
  codes: {}, // code -> authorization code (single use, 60 s)
  access_tokens: {}, // token -> { device_id, user_id, jkt, exp }
  refresh_tokens: {}, // token -> { device_id, user_id, jkt, exp }
  sessions: {}, // Mcp-Session-Id -> { device_id, created_at }
  challenges: {}, // id -> challenge
  decisions: [], // newest last
  events: [], // newest last
  rejections: [], // refused credentials (stolen tokens, wrong key, revoked device)
});

let state;
try {
  state = { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) };
} catch {
  state = empty();
}

let timer;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    mkdirSync(dirname(file), { recursive: true });
    state.decisions = state.decisions.slice(-500);
    state.events = state.events.slice(-2000);
    state.rejections = state.rejections.slice(-500);
    writeFileSync(file, JSON.stringify(state, null, 2));
  }, 200);
}

export const db = state;
export const findDeviceByJkt = (jkt) => Object.values(state.devices).find((d) => d.jkt === jkt);
