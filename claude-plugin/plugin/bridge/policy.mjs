// Tool policy: what the model may see and call.
//
// effective action = most restrictive of (org policy, user rules, project rules)
//   allow < ask < deny < hide
//   hide: removed from tools/list, the model never sees the tool
//   deny: visible, but calls are refused locally (and by the server)
//   ask : Claude Code asks the user before the call (PreToolUse hook)
// Local rules can only restrict. The server enforces org policy independently.
//
// Approval level per tool (org rule `approval`, else `approval_defaults[tier]`):
//   none < confirm < touchid < browser
//   none    Claude Code's own permission handling
//   confirm yes/no dialog from the bridge (MCP form elicitation), every time
//   touchid presence proof signed by the Touch ID key (server-enforced)
//   browser approval page with fresh sign-in (server-enforced challenge)
// A local "ask" rule raises a tool to at least confirm.

import { join } from 'node:path';
import { config } from './config.mjs';
import { globMatch, readJson, sha256b64url, stableStringify, writeJson } from './util.mjs';

const RANK = { allow: 0, ask: 1, deny: 2, hide: 3 };
export const APPROVAL_RANK = { none: 0, confirm: 1, touchid: 2, browser: 3 };
const higherApproval = (...levels) =>
  levels.filter((l) => l in APPROVAL_RANK).reduce((a, b) => (APPROVAL_RANK[b] > APPROVAL_RANK[a] ? b : a), 'none');

export const DEFAULT_POLICY = {
  version: 'default',
  refresh_seconds: 60,
  default_action: 'allow',
  tools: [],
  argument_rules: [],
  approval_defaults: { read: 'none', write: 'none', destructive: 'touchid' },
  pinning: 'enforce',
  pinned: {},
  telemetry: { flush_seconds: 5 },
};

const strictest = (...actions) =>
  actions.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow');

function localRules() {
  const files = [config.paths.userRules, join(config.projectDir, '.hy-guard', 'rules.json')];
  const merged = { hide: [], deny: [], ask: [] };
  for (const f of files) {
    const r = readJson(f, {});
    for (const k of Object.keys(merged)) merged[k].push(...(r[k] ?? []));
  }
  return merged;
}

export function toolDefinitionHash(tool) {
  return sha256b64url(
    stableStringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
  );
}

export function tierOf(tool, orgRule) {
  if (orgRule?.tier) return orgRule.tier;
  const a = tool.annotations ?? {};
  if (a.destructiveHint) return 'destructive';
  if (a.readOnlyHint) return 'read';
  return 'write';
}

export class PolicyEngine {
  constructor() {
    this.policy = { ...DEFAULT_POLICY, ...(readJson(config.paths.policyCache)?.policy ?? {}) };
    this.etag = null;
    this.decisions = new Map(); // tool name -> { action, tier, reason }
  }

  setPolicy(policy, etag) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.etag = etag;
  }

  #orgRule(name) {
    return this.policy.tools.find((r) => globMatch(r.match, name));
  }

  #localAction(name) {
    const rules = localRules();
    for (const action of ['hide', 'deny', 'ask']) {
      if (rules[action].some((p) => globMatch(p, name))) return action;
    }
    return 'allow';
  }

  /**
   * Check a tool definition against the pins. Org pins (set by admins in policy)
   * win; otherwise the first definition seen on this device is trusted (TOFU).
   * Returns { ok, changed, hash }.
   */
  #checkPin(tool) {
    const hash = toolDefinitionHash(tool);
    const orgPin = this.policy.pinned?.[tool.name];
    if (orgPin) return { ok: orgPin === hash, changed: orgPin !== hash, hash };
    const pins = readJson(config.paths.pins, {});
    const scope = (pins[config.platformUrl] ??= {});
    if (!scope[tool.name]) {
      scope[tool.name] = hash;
      writeJson(config.paths.pins, pins);
      return { ok: true, changed: false, hash };
    }
    return { ok: scope[tool.name] === hash, changed: scope[tool.name] !== hash, hash };
  }

  /**
   * Filter and annotate the gateway's tools. Returns visible tools plus a list of
   * findings (e.g. changed definitions) for telemetry.
   */
  apply(tools) {
    const visible = [];
    const findings = [];
    this.decisions.clear();
    for (const tool of tools) {
      const org = this.#orgRule(tool.name);
      const tier = tierOf(tool, org);
      const local = this.#localAction(tool.name);
      let action = strictest(this.policy.default_action, org?.action, local === 'ask' ? 'allow' : local);
      let reason = org ? `org rule ${org.match}` : 'default';
      const approval = higherApproval(
        org?.approval ?? this.policy.approval_defaults?.[tier] ?? 'none',
        org?.action === 'ask' || local === 'ask' ? 'confirm' : 'none', // legacy/local "ask"
      );

      if (this.policy.pinning !== 'off' && !config.simulateSkipLocalRules) {
        const pin = this.#checkPin(tool);
        if (pin.changed) {
          findings.push({ type: 'tool_definition_changed', tool: tool.name, hash: pin.hash });
          if (this.policy.pinning === 'enforce') {
            action = 'hide';
            reason = 'tool definition changed since it was pinned';
          }
        }
      }
      this.decisions.set(tool.name, { action, tier, reason, approval });
      if (action === 'hide') continue;

      const notes = [];
      if (approval === 'confirm') notes.push('the user confirms each call');
      if (approval === 'touchid') notes.push('each call needs Touch ID');
      if (approval === 'browser') notes.push('each call needs approval in the browser with a fresh sign-in');
      if (action === 'deny') notes.push('blocked by policy');
      visible.push(
        notes.length ? { ...tool, description: `${tool.description ?? ''}\n[hy-guard: ${notes.join('; ')}]` } : tool,
      );
    }
    this.#writeCache();
    return { visible, findings };
  }

  decision(name) {
    return this.decisions.get(name) ?? { action: 'hide', tier: 'write', reason: 'unknown tool', approval: 'none' };
  }

  /** Whether Claude Code can show our dialogs; the hook falls back to Claude Code's "ask" if not. */
  setClientDialogs(supported) {
    this.clientDialogs = supported;
    this.#writeCache();
  }

  /** Local argument rules. Returns an error message or null. */
  checkArguments(name, args = {}) {
    for (const r of this.policy.argument_rules ?? []) {
      if (!globMatch(r.tool, name)) continue;
      const value = args[r.argument];
      const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
      const re = new RegExp(r.pattern);
      const bad = values.find((v) => !re.test(String(v)));
      if (bad !== undefined) return r.message ?? `argument ${r.argument}=${bad} not allowed by policy`;
    }
    return null;
  }

  /** The hook process reads this file; it never reads the network. */
  #writeCache() {
    writeJson(config.paths.policyCache, {
      updated_at: new Date().toISOString(),
      client_dialogs: Boolean(this.clientDialogs),
      policy: this.policy,
      tools: Object.fromEntries(this.decisions),
    });
  }
}
