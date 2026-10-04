// The MCP server Claude Code talks to over stdio (newline-delimited JSON-RPC).
// It answers tools/list itself (filtered by policy) and forwards tools/call to
// the gateway with DPoP. Two local tools exist: hy_login and hy_status.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { actionHash } from './hook.mjs';
import { config } from './config.mjs';
import { error, info, warn } from './log.mjs';
import { openBrowser } from './platform.mjs';
import { describeArgs } from './telemetry.mjs';
import { GatewayError } from './upstream.mjs';
import { readJson, shortCode, sleep } from './util.mjs';
import { serverOf, serversOf, switchedOff } from './mcp-selection.mjs';
import { uiCall, uiToast, uiServers } from './ui-state.mjs';

/** Per tool call: { requestId, progressToken, toolUseId } (parallel calls stay apart). */
const callCtx = new AsyncLocalStorage();
const ctx = () => callCtx.getStore() ?? {};

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CHALLENGE_POLL_MS = 1500;
const CHALLENGE_MAX_WAIT_MS = 120_000;
const HOOK_REF_MAX_AGE_S = 120;

/** Take (and consume) the PreToolUse record for exactly this call, if Claude Code made one. */
function takeHookRef(name, args) {
  const ah = actionHash(name, args);
  const file = join(config.paths.hookRefs, `${ah}.json`);
  const ref = readJson(file);
  try {
    unlinkSync(file);
  } catch {}
  // drop stale records left by calls that never happened
  try {
    for (const f of readdirSync(config.paths.hookRefs)) {
      const p = join(config.paths.hookRefs, f);
      if (Date.now() - statSync(p).mtimeMs > HOOK_REF_MAX_AGE_S * 1000) unlinkSync(p);
    }
  } catch {}
  if (!ref || ref.ah !== ah || Date.now() / 1000 - ref.ts > HOOK_REF_MAX_AGE_S) return null;
  return { sid: ref.sid, eid: ref.eid, ah, ts: ref.ts };
}

// JSON-RPC error codes the gateway uses for trust decisions (see BACKEND_CONTRACT.md)
export const ERR_CHALLENGE = -32010;
export const ERR_DENIED = -32011;

const LOCAL_TOOLS = {
  hy_login: {
    name: 'hy_login',
    description:
      'Sign in to the company tool gateway. Opens the browser for SSO and device approval, then waits until it completes. Call this when the user asks to sign in or when gateway tools are missing.',
    inputSchema: { type: 'object', properties: {} },
  },
  hy_status: {
    name: 'hy_status',
    description: 'Show sign-in state, device key, and which gateway tools policy hides or restricts.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
};

/** Short, readable argument summary for dialogs and prompts. */
function summarizeArgs(args, max = 300) {
  const parts = Object.entries(args ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const s = parts.join('\n');
  return s.length > max ? `${s.slice(0, max)}…` : s || '(no arguments)';
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export class McpServer {
  constructor({ platform, upstream, policy, telemetry, keys }) {
    Object.assign(this, { platform, upstream, policy, telemetry, keys });
    this.clientInfo = null;
    this.autoLoginTried = false;
    this.tamperError = null; // last "possible man-in-the-middle" failure, shown to the user
    this.outgoing = new Map(); // our requests to Claude Code (elicitation) awaiting a response
    this.outSeq = 0;
  }

  start() {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return this.#send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      this.#handle(msg).catch((e) => error('handler failed', { error: e.message }));
    });
    rl.on('close', () => (this.onClose ? this.onClose() : process.exit(0)));
  }

  #send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  notifyToolsChanged() {
    this.#send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  /** Send a request to Claude Code (e.g. elicitation/create) and wait for its response. */
  #request(method, params) {
    const id = `hy-${++this.outSeq}`;
    return new Promise((resolve, reject) => {
      this.outgoing.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  get #dialogs() {
    const e = this.clientCapabilities?.elicitation;
    return { form: Boolean(e && (e.form || Object.keys(e).length === 0)), url: Boolean(e?.url) };
  }

  async #handle(msg) {
    if (msg.id !== undefined && !msg.method) {
      // response to one of our requests
      const p = this.outgoing.get(msg.id);
      if (p) {
        this.outgoing.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'notifications/cancelled') {
      (this.cancelled ??= new Set()).add(msg.params?.requestId); // Esc in Claude Code
      return;
    }
    if (msg.id === undefined) return; // notifications (initialized, ...) need no reply
    const reply = (result) => this.#send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => this.#send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize': {
        this.clientInfo = msg.params?.clientInfo ?? null;
        this.clientCapabilities = msg.params?.capabilities ?? {};
        info('client connected', { client: this.clientInfo, capabilities: this.clientCapabilities, protocol: msg.params?.protocolVersion });
        this.policy.setClientDialogs(this.#dialogs.form);
        this.telemetry.context.client = this.clientInfo;
        if (this.clientInfo) this.platform.client = { name: this.clientInfo.name, version: this.clientInfo.version };
        const requested = msg.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'hy-guard-bridge', version: config.version },
          instructions:
            'Company tools are served through hy-guard. If no company tools are listed, call hy_login. Some tools require the user to approve in the browser or with Touch ID; wait for the result.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: await this.#listTools() });
      case 'tools/call': {
        const meta = msg.params?._meta ?? {};
        const c = { requestId: msg.id, progressToken: meta.progressToken, toolUseId: meta['claudecode/toolUseId'] };
        return reply(await callCtx.run(c, () => this.#callToolWithUi(msg.params?.name, msg.params?.arguments ?? {})));
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  async #listTools() {
    if (!this.platform.isSignedIn()) {
      if (config.autoLogin && !this.autoLoginTried && !config.simulateStolen) {
        this.autoLoginTried = true;
        this.platform.login().catch((e) => warn('auto login failed', { error: e.message }));
      }
      return [LOCAL_TOOLS.hy_login, LOCAL_TOOLS.hy_status];
    }
    try {
      const { tools } = await this.upstream.request('tools/list', {});
      const { visible, findings } = this.policy.apply(tools);
      this.toolDefs = new Map(tools.map((t) => [t.name, t]));
      for (const f of findings) this.telemetry.emit(f.type, f);
      this.telemetry.emit('tools_listed', {
        upstream: tools.length,
        visible: visible.length,
        hidden: tools.filter((t) => this.policy.decision(t.name).action === 'hide').map((t) => t.name),
      });
      this.tamperError = null;
      // Servers the person switched off for this session (/mcps) are left out.
      uiServers(serversOf(visible));
      const off = switchedOff();
      return [...visible.filter((t) => !off.has(serverOf(t.name))), LOCAL_TOOLS.hy_status];
    } catch (e) {
      warn('tools/list failed', { error: e.message });
      if (e.code === 'response_tampered') {
        this.tamperError = e.message;
        this.telemetry.emit('response_tampered', { during: 'tools/list', error: e.message });
      }
      return [LOCAL_TOOLS.hy_login, LOCAL_TOOLS.hy_status];
    }
  }

  /** Progress line under the running tool call in Claude Code. */
  #progress(token, message) {
    if (token === undefined) return;
    this.progressSeq = (this.progressSeq ?? 0) + 1;
    this.#send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: this.progressSeq, message } });
  }

  /** "Delete a branch in a company Git repository (repo: web, branch: old)" */
  #describe(name, args) {
    const desc = (this.toolDefs?.get(name)?.description ?? name).split(/(?<=\.)\s/)[0].replace(/\.$/, '');
    return `${desc} (${summarizeArgs(args, 70).replaceAll('\n', ', ')})`;
  }

  /** Wraps a tool call with the state the in-Claude-Code card shows. */
  async #callToolWithUi(name, args) {
    const local = name === 'hy_login' || name === 'hy_status';
    const d = this.policy.decision(name);
    if (!local)
      uiCall(ctx().toolUseId, { tool: name, description: this.#describe(name, args).replace(/ \(.*\)$/, ''), args: summarizeArgs(args, 160), approval: d.approval, state: 'running', note: null, url: null });
    const result = await this.#callTool(name, args);
    if (local) return result;
    const texts = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    const approvalNote = texts.find((t) => t.startsWith('✓ Approved'));
    if (result.isError) {
      const why = (texts[0] ?? 'refused').slice(0, 200);
      uiCall(ctx().toolUseId, { state: 'blocked', note: why });
      uiToast('blocked', `⛔ ${name} blocked: ${why.slice(0, 120)}`); // Claude Code prefixes "hy-guard:"
    } else {
      uiCall(ctx().toolUseId, { state: 'done', note: approvalNote ?? '✓ Done (signed by this device)' });
      if (approvalNote) uiToast('approved', approvalNote);
    }
    return result;
  }

  async #callTool(name, args) {
    const progressToken = ctx().progressToken;
    if (name === 'hy_login') return this.#login();
    if (name === 'hy_status') return text(this.#status());
    if (!this.platform.isSignedIn()) return text('Not signed in. Call hy_login first.', true);
    if (switchedOff().has(serverOf(name)))
      return text(`The ${serverOf(name)} server is switched off for this session. The user can turn it on with /mcps.`, true);

    const d = this.policy.decision(name);
    if (this.tamperError && !this.policy.decisions.has(name)) return text(`Blocked: ${this.tamperError}.`, true);
    if (d.action === 'hide' || d.action === 'deny') {
      this.telemetry.emit('tool_blocked_locally', { tool: name, action: d.action, reason: d.reason });
      return text(`Blocked by policy (${d.reason}).`, true);
    }
    const argError = config.simulateSkipLocalRules ? null : this.policy.checkArguments(name, args);
    if (argError) {
      this.telemetry.emit('tool_blocked_locally', { tool: name, action: 'argument_rule', reason: argError });
      return text(`Blocked by policy: ${argError}`, true);
    }

    // Approval level "confirm": our own dialog, every call (no "don't ask again").
    if (d.approval === 'confirm' && this.#dialogs.form) {
      uiCall(ctx().toolUseId, { state: 'waiting_confirm' });
      const answer = await this.#request('elicitation/create', {
        mode: 'form',
        message: `hy-guard: allow ${name}?\n\n${summarizeArgs(args)}\n\nCompany policy asks you to confirm every call (${d.reason}).`,
        requestedSchema: { type: 'object', properties: {} },
      }).catch((e) => ({ action: 'cancel', error: e.message }));
      this.telemetry.emit('confirmation', { tool: name, action: answer.action });
      if (answer.action !== 'accept') return text(`The user did not confirm ${name}; it was not run.`, true);
      uiCall(ctx().toolUseId, { state: 'running' });
    }

    const started = performance.now();
    // Approval level "touchid": sign with the presence key. macOS shows
    // "hy-guard is trying to run <tool> via <host> (<arguments>)", written by the signer.
    const presence = config.presence && d.approval === 'touchid';
    if (presence) {
      this.#progress(progressToken, `Waiting for Touch ID on this Mac: ${this.#describe(name, args)}`);
      uiCall(ctx().toolUseId, { state: 'waiting_touchid' });
    }
    const hook = takeHookRef(name, args);
    // Signals like "just read a web page" must reach the platform before the action they
    // concern, not on the next 5 s telemetry tick.
    if (d.tier !== 'read') await this.telemetry.flush().catch(() => {});
    let result = await this.#forward(name, args, presence, null, hook);
    if (presence && !result.isError)
      result = { ...result, content: [...(result.content ?? []), { type: 'text', text: `✓ Approved with Touch ID on device ${shortCode(this.keys.thumbprint)}.` }] };
    this.telemetry.emit('tool_call', {
      tool: name,
      tier: d.tier,
      approval: d.approval,
      args: describeArgs(args),
      outcome: result.isError ? 'error' : 'ok',
      hook_correlated: Boolean(hook),
      ms: Math.round(performance.now() - started),
    });
    return result;
  }

  async #forward(name, args, presence, challengeId, hook) {
    try {
      return await this.upstream.request(
        'tools/call',
        { name, arguments: args },
        { presence, claims: hook ? { hook } : undefined, headers: challengeId ? { 'HY-Challenge-Id': challengeId } : {} },
      );
    } catch (e) {
      if (e.code === 'response_tampered') {
        this.telemetry.emit('response_tampered', { tool: name, error: e.message });
        return text(`Blocked: ${e.message}. The tool result was discarded.`, true);
      }
      if (presence && /LAError|authentication|sign:/i.test(e.message ?? ''))
        return text(`Touch ID was cancelled or failed, so ${name} was not run.`, true);
      if (e.code === 'unlock_cancelled') return text(`Touch ID unlock was cancelled or failed. ${e.message}`, true);
      if (e.code === 'auth_required') {
        this.notifyToolsChanged();
        const why = this.platform.lastRejection ? ` The platform said: ${this.platform.lastRejection}.` : '';
        return text(`Your session ended.${why} Call hy_login to sign in again.`, true);
      }
      if (e instanceof GatewayError && e.rpc.code === ERR_CHALLENGE && !challengeId) {
        return this.#handleChallenge(name, args, presence, e.rpc.data?.challenge, hook);
      }
      if (e instanceof GatewayError && e.rpc.code === ERR_DENIED) {
        const reasons = (e.rpc.data?.reasons ?? []).join('; ');
        return text(`Denied by the security platform${reasons ? `: ${reasons}` : ''}.`, true);
      }
      return text(`Gateway error: ${e.message}`, true);
    }
  }

  /** Open the approval page in the user's browser and wait for their decision. */
  async #handleChallenge(name, args, presence, challenge, hook) {
    if (!challenge?.id) return text('Approval required, but the gateway sent no challenge.', true);
    info('approval required', { tool: name, challenge: challenge.id, reasons: challenge.reasons });
    this.telemetry.emit('challenge_shown', { tool: name, challenge_id: challenge.id, reasons: challenge.reasons });

    // Default: open the approval page right away; the page shows the details before the
    // fresh sign-in. HY_BROWSER_APPROVAL=dialog asks in Claude Code first (URL elicitation).
    let dialog = null;
    const requestId = ctx().requestId;
    const useDialog = config.browserApproval === 'dialog' && this.#dialogs.url;
    if (useDialog) {
      this.#request('elicitation/create', {
        mode: 'url',
        elicitationId: challenge.id,
        url: challenge.approve_url,
        message: `hy-guard: approve ${name} in your browser (you'll sign in again).\nWhy: ${(challenge.reasons ?? []).join('; ')}`,
      })
        .then((r) => (dialog = r.action))
        .catch(() => (dialog = 'cancel'));
    } else {
      openBrowser(challenge.approve_url);
    }
    const complete = () => useDialog && this.#send({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: challenge.id } });
    uiCall(ctx().toolUseId, { state: 'waiting_browser', url: challenge.approve_url, note: (challenge.reasons ?? []).join('; ') });
    this.#progress(
      ctx().progressToken,
      `Waiting for approval in the browser: ${this.#describe(name, args)}. Not open? ${challenge.approve_url}`,
    );

    const deadline = Date.now() + Math.min(CHALLENGE_MAX_WAIT_MS, (challenge.expires_in ?? 120) * 1000);
    while (Date.now() < deadline) {
      await sleep(CHALLENGE_POLL_MS);
      if (dialog === 'decline' || dialog === 'cancel') return text(`The user declined to approve ${name}.`, true);
      if (this.cancelled?.has(requestId)) return text(`Approval of ${name} was cancelled in Claude Code.`, true);
      const { status, approved_by: by } = await this.platform.getChallenge(challenge.id).catch(() => ({ status: 'pending' }));
      if (status === 'approved') {
        complete();
        const r = await this.#forward(name, args, presence, challenge.id, hook);
        if (r.isError) return r;
        const note = `✓ Approved in the browser${by ? ` by ${by}` : ''} (fresh sign-in).`;
        return { ...r, content: [...(r.content ?? []), { type: 'text', text: note }] };
      }
      if (status === 'denied') {
        complete();
        return text('The user denied this action in the browser.', true);
      }
      if (status === 'expired') break;
    }
    return text(
      `Approval timed out. Ask the user to approve at ${challenge.approve_url} and try again. Reasons: ${(challenge.reasons ?? []).join('; ')}`,
      true,
    );
  }

  async #login() {
    if (this.platform.isSignedIn()) return text(this.#status());
    try {
      const pending = this.platform.login();
      await sleep(100); // let the login URL be generated
      info('waiting for browser sign-in');
      await pending;
      return text(
        `Signed in as ${this.platform.tokens?.user?.email ?? 'unknown'}. Company tools are now available.\n${this.#status()}`,
      );
    } catch (e) {
      return text(
        `Sign-in failed: ${e.message}${this.platform.lastLoginUrl ? `\nOpen manually: ${this.platform.lastLoginUrl}` : ''}`,
        true,
      );
    }
  }

  #status() {
    const t = this.platform.tokens;
    const lines = [
      `Platform: ${config.platformUrl}`,
      `Signed in: ${t ? `yes (${t.user?.email ?? 'unknown user'})` : 'no'}`,
      `Device key: ${this.keys.storage}, code ${shortCode(this.keys.thumbprint)}${this.keys.hasPresence() ? ', Touch ID key present' : ''}`,
      `Policy: ${this.policy.policy.version}`,
    ];
    if (this.tamperError) lines.push(`⚠ ${this.tamperError}`);
    const off = [...switchedOff()];
    if (off.length) lines.push(`Servers switched off for this session (/mcps): ${off.join(', ')}`);
    const restricted = [...this.policy.decisions].filter(([, d]) => d.action !== 'allow' || d.tier !== 'read');
    if (restricted.length) {
      lines.push('Tools with restrictions:');
      for (const [n, d] of restricted) lines.push(`  ${n}: ${d.action}, tier ${d.tier} (${d.reason})`);
    }
    return lines.join('\n');
  }
}
