// MCP client for the gateway (Streamable HTTP transport). Every request is
// DPoP-signed by PlatformClient.fetch. Responses may be JSON or an SSE stream.

import { config } from './config.mjs';
import { info } from './log.mjs';

const PROTOCOL_VERSION = '2025-06-18';

export class GatewayError extends Error {
  constructor(rpcError) {
    super(rpcError.message);
    this.rpc = rpcError;
  }
}

export class Upstream {
  constructor(platform) {
    this.platform = platform;
    this.sessionId = null;
    this.seq = 0;
    this.initializing = null;
  }

  async url() {
    return (await this.platform.discover()).gateway_url;
  }

  reset() {
    this.sessionId = null;
  }

  async #ensureSession() {
    if (this.sessionId) return;
    this.initializing ??= (async () => {
      const result = await this.#send(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'hy-guard-bridge', version: config.version },
        },
        {},
        true,
      );
      await this.#notify('notifications/initialized');
      info('gateway session ready', { session: this.sessionId, server: result.serverInfo });
    })().finally(() => (this.initializing = null));
    await this.initializing;
  }

  /** JSON-RPC request. `opts.presence` adds the Touch ID proof, `opts.headers` extra headers. */
  async request(method, params, opts = {}) {
    await this.#ensureSession();
    try {
      return await this.#send(method, params, opts);
    } catch (e) {
      if (e.sessionExpired) {
        this.reset();
        await this.#ensureSession();
        return this.#send(method, params, opts);
      }
      throw e;
    }
  }

  async #notify(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    await this.platform.fetch(await this.url(), { method: 'POST', body, headers: this.#headers() });
  }

  #headers(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...extra,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async #send(method, params, opts, isInit = false) {
    const id = ++this.seq;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const res = await this.platform.fetch(await this.url(), {
      method: 'POST',
      body,
      headers: this.#headers(opts.headers),
      presence: opts.presence,
      claims: opts.claims,
    });
    if (res.status === 404 && this.sessionId) {
      const err = new Error('gateway session expired');
      err.sessionExpired = true;
      throw err;
    }
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}: ${await res.text()}`);
    if (isInit) this.sessionId = res.headers.get('mcp-session-id');

    const msg = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? await readSseResponse(res, id)
      : await res.json();
    if (msg.error) throw new GatewayError(msg.error);
    return msg.result;
  }
}

/** Read SSE events until the JSON-RPC response with our id arrives. */
async function readSseResponse(res, id) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    }
  }
  throw new Error('gateway stream ended without a response');
}
