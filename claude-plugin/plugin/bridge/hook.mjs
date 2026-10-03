// Claude Code hook handler (SessionStart, PreToolUse). Runs as a short-lived
// process per hook event, so it never touches the network or the device key:
//   - appends an event to the spool file (the bridge uploads it)
//   - answers PreToolUse for gateway tools from the policy cache written by the bridge
// The server enforces policy on its own; this only improves the local UX.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { readJson, sha256b64url, stableStringify, uuid, writeJson } from './util.mjs';

/** Same formula as the gateway's action hash: sha256(canonical {tool, arguments}). */
export const actionHash = (tool, args) => sha256b64url(stableStringify({ tool, arguments: args ?? {} }));

const GATEWAY_PREFIX = /^mcp__plugin_.*_gateway__/;
// Built-in tools whose results are outside content; policy.untrusted_content.builtin_sources
// overrides. (Company MCP tools are marked by the platform via `untrusted_source`.)
const DEFAULT_UNTRUSTED = ['WebFetch', 'WebSearch'];

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s ? JSON.parse(s) : {};
}

function spool(type, data, input) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const event = {
    event_id: uuid(),
    type,
    ts: new Date().toISOString(),
    source: 'hook',
    context: { claude_session_id: input.session_id, cwd: input.cwd },
    data,
  };
  appendFileSync(config.paths.hookSpool, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function summarizeInput(toolName, toolInput = {}) {
  const out = { keys: Object.keys(toolInput) };
  if (toolName === 'WebFetch' && toolInput.url) {
    try {
      out.domain = new URL(toolInput.url).hostname;
    } catch {}
  }
  return out;
}

export async function runHook() {
  const input = await readStdin();
  const event = input.hook_event_name;

  if (event === 'SessionStart') {
    spool('session_start', { source: input.source }, input);
    const tokens = readJson(config.paths.tokens, {});
    if (!tokens.access_token) {
      out({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            'hy-guard: the user is not signed in to the company tool gateway. If they need company tools, call the hy_login tool (or tell them to run /hy-guard:login).',
        },
      });
    }
    return;
  }

  if (event === 'PreToolUse') {
    const tool = input.tool_name ?? '';
    spool(
      'pre_tool_use',
      {
        tool,
        untrusted_content: new Set(readJson(config.paths.policyCache, {})?.policy?.untrusted_content?.builtin_sources ?? DEFAULT_UNTRUSTED).has(tool),
        input: summarizeInput(tool, input.tool_input),
      },
      input,
    );
    if (!GATEWAY_PREFIX.test(tool)) return;
    const name = tool.replace(GATEWAY_PREFIX, '');
    // Correlation record: the bridge puts it into the signed proof of the matching call,
    // so the platform can tell calls Claude Code started from ones it didn't.
    const ah = actionHash(name, input.tool_input);
    writeJson(join(config.paths.hookRefs, `${ah}.json`), { sid: input.session_id, eid: uuid(), ah, ts: Math.floor(Date.now() / 1000) });
    const cache = readJson(config.paths.policyCache, {});
    const d = cache?.tools?.[name];
    if (!d) return;
    if (d.action === 'hide' || d.action === 'deny') {
      return out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `hy-guard policy: ${d.reason} (tier ${d.tier})`,
        },
      });
    }
    // "confirm" is asked by the bridge itself (dialog, every time, no "don't ask again").
    // Only clients that can't show our dialogs fall back to Claude Code's own prompt.
    if (d.approval === 'confirm' && !cache.client_dialogs) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `hy-guard policy: confirm each call (${d.reason})`,
        },
      });
    }
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
