// State contract of the hy-guard mod (hooks/ui.tsx). Written by the bridge as
// <data dir>/ui-state.json (bridge/ui-state.mjs), mirrored into $.state by the mod.

export type CallState = 'running' | 'waiting_confirm' | 'waiting_touchid' | 'waiting_browser' | 'done' | 'blocked';

export type UiCall = {
  tool: string;
  description?: string;
  args?: string;
  approval?: 'none' | 'confirm' | 'touchid' | 'browser';
  state: CallState;
  note?: string | null;
  url?: string | null;
  at: string;
};

export type UiState = {
  updated_at?: string;
  signed_in?: boolean;
  user?: string | null;
  device_code?: string;
  key_storage?: string;
  posture?: { zta: number | null; os: { fv: boolean | null; sip: boolean | null; gk: boolean | null; fw: boolean | null } | null };
  /** Company MCP servers behind the gateway, for /mcps. */
  servers?: { name: string; tools: number }[];
  calls?: Record<string, UiCall>;
  last_event?: { id: string; kind: string; text: string; at: string };
};

declare module 'claude-code' {
  interface PluginState {
    'hy-guard': { ui: UiState | null; mcpsOff: string[] };
  }
}
