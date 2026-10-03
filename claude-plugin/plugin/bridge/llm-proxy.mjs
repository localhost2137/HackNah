// Local model-API proxy: Claude Code -> 127.0.0.1 -> platform LLM gateway, with a
// DPoP proof (including body hash) on every request, signed by the device key.
//
// Claude Code reaches it through ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and
// authenticates with a local secret printed by `main.mjs llm-key` (apiKeyHelper).
// That helper also starts this proxy in the background when it isn't running.

import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.mjs';
import { error, info } from './log.mjs';
import { AuthRequiredError } from './platform.mjs';
import { randomId, readJson, sleep, writeJson } from './util.mjs';

const IDLE_EXIT_MS = Number(process.env.HY_LLM_IDLE_EXIT_MS ?? 2 * 60 * 60_000);
// Hop-by-hop and credential headers never go upstream; the platform gets DPoP instead.
const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'accept-encoding', 'keep-alive', 'transfer-encoding']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'dpop-nonce']);

/** Local secret shared between apiKeyHelper output and the proxy (0600 file). */
export function localSecret() {
  const s = readJson(config.paths.llmSecret);
  if (typeof s === 'string' && s) return s;
  const fresh = `hy-local-${randomId(24)}`;
  writeJson(config.paths.llmSecret, fresh);
  return fresh;
}

const apiError = (status, message) => ({
  status,
  body: JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message } }),
});

export async function runLlmProxy(platform) {
  const secret = localSecret();
  const gateway = (await platform.discover()).llm_gateway_url;
  if (!gateway) throw new Error('platform has no llm_gateway_url');
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };
  touch();

  const server = createServer(async (req, res) => {
    touch();
    const send = ({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    // Connection-warming probe; answer locally.
    if (req.url === '/api/hello') return res.writeHead(200).end();
    // Identity check for apiKeyHelper: prove we know the local secret (see proxyState).
    if (req.url.startsWith('/hy/identity?')) {
      const nonce = new URL(req.url, 'http://127.0.0.1').searchParams.get('nonce') ?? '';
      return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(identityProof(secret, nonce));
    }

    const presented = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (presented !== secret) return send(apiError(401, 'hy-guard local proxy: wrong local key'));

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k)) headers[k] = v;

    try {
      const started = performance.now();
      // Claude Code identifies itself in User-Agent, e.g. "claude-cli/2.1.288 (external, cli)".
      const ua = /^([\w.-]+)\/([\w.+-]+)/.exec(req.headers['user-agent'] ?? '');
      const client = ua ? { name: ua[1], version: ua[2] } : null;
      const upstream = await platform.fetch(`${gateway}${req.url}`, { method: req.method, body, headers, client });
      const out = {};
      upstream.headers.forEach((v, k) => {
        if (!DROP_RESPONSE.has(k)) out[k] = v;
      });
      res.writeHead(upstream.status, out);
      // Stream through without buffering (SSE).
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      info('llm request', { path: req.url, status: upstream.status, ms: Math.round(performance.now() - started) });
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        const why = platform.lastRejection
          ? ` The platform said: ${platform.lastRejection}.`
          : ' This device has no valid credentials (they were refused and cleared).';
        if (config.simulateStolen || !config.autoLogin)
          return send(apiError(401, `hy-guard: the platform rejected these credentials.${why}`));
        platform.login().catch(() => {});
        return send(apiError(401, `Not signed in to hy-guard.${why} A browser window opened to sign in; retry afterwards.`));
      }
      error('llm proxy failed', { error: e.message });
      if (!res.headersSent) send(apiError(502, `hy-guard local proxy: ${e.message}`));
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.llmPort, '127.0.0.1', resolve);
  });
  info('llm proxy listening', { port: config.llmPort, gateway });
}

const identityProof = (secret, nonce) => createHmac('sha256', secret).update(`hy-proxy:${nonce}`).digest('hex');

/**
 * Who answers on the proxy port? 'none', 'ours', or 'foreign'. Another local user could
 * bind the port first and receive Claude Code's prompts (and answer with injected text).
 * Only our proxy knows the 0600 local secret, so it alone can answer the HMAC challenge.
 */
async function proxyState(secret) {
  const nonce = randomBytes(16).toString('hex');
  let body;
  try {
    const res = await fetch(`http://127.0.0.1:${config.llmPort}/hy/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(500) });
    body = await res.text();
  } catch {
    return 'none';
  }
  const want = Buffer.from(identityProof(secret, nonce));
  const got = Buffer.from(body.trim());
  return got.length === want.length && timingSafeEqual(got, want) ? 'ours' : 'foreign';
}

/**
 * PIDs on the proxy port that are an older hy-guard proxy run by this same user (e.g. from
 * before an update, or with another data dir). Those may be replaced; anything else may not.
 */
function staleOwnProxies() {
  if (process.platform === 'win32') return [];
  try {
    const pids = execFileSync('lsof', ['-nP', '-tiTCP:' + config.llmPort, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    return pids.filter((pid) => {
      const [uid, ...cmd] = execFileSync('ps', ['-o', 'uid=,command=', '-p', pid], { encoding: 'utf8' }).trim().split(/\s+/);
      return Number(uid) === process.getuid() && cmd.join(' ').includes('/bridge/main.mjs llm-proxy');
    });
  } catch {
    return [];
  }
}

/** apiKeyHelper: make sure OUR proxy runs, then print the local secret (and nothing else). */
export async function runLlmKey() {
  const secret = localSecret();
  let state = await proxyState(secret);
  if (state === 'foreign') {
    const stale = staleOwnProxies();
    for (const pid of stale) process.kill(Number(pid));
    if (stale.length) {
      for (let i = 0; i < 20 && (state = await proxyState(secret)) !== 'none'; i++) await sleep(100);
    }
  }
  if (state === 'none') {
    spawn(process.execPath, [new URL('./main.mjs', import.meta.url).pathname, 'llm-proxy'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }).unref();
    for (let i = 0; i < 40 && (state = await proxyState(secret)) === 'none'; i++) await sleep(100);
  }
  if (state !== 'ours') {
    process.stderr.write(
      `hy-guard: port ${config.llmPort} is held by a process that is not the hy-guard proxy; refusing to route model traffic there\n`,
    );
    process.exit(1);
  }
  process.stdout.write(secret);
}
