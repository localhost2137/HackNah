// Mock platform backend: discovery, OAuth (code + PKCE + DPoP), policy, events,
// challenges, and an MCP gateway that verifies DPoP on every request.
// Zero dependencies. The real backend replaces this; docs/BACKEND_CONTRACT.md is the contract.
//
// env:
//   PORT=8787  PUBLIC_URL=http://127.0.0.1:8787  MOCK_POLICY_FILE (default ./policy.json)
//   MOCK_AUTO_APPROVE=1      approve sign-ins and challenges without clicking (tests)
//   MOCK_TRUST_IP_HEADER=1   honour X-Mock-Client-IP (simulate other networks)
//   ACCESS_TOKEN_TTL=300  REFRESH_TOKEN_TTL=43200
//   UPSTREAM_ANTHROPIC_API_KEY=sk-ant-...  company key the LLM gateway forwards with
//   UPSTREAM_ANTHROPIC_URL=https://api.anthropic.com
//   MOCK_LLM_FAKE=1          canned model replies even when an upstream key is set (default without a key)
//   MOCK_FINGERPRINT=enforce reject a known key from a different machine (dfp mismatch); "log" only records it
//   FALCON_CROSSCHECK=1      confirm ZTA with the Falcon API by agent ID (mock Falcon unless FALCON_BASE_URL)
//   FALCON_BASE_URL, FALCON_CLIENT_ID, FALCON_CLIENT_SECRET, FALCON_CACHE_S=10
//   CAEP_SECRET              bearer secret for pushed security events (/v1/signals/caep)
//   UNLOCK_TTL=28800         session unlock window (s). After it, refresh needs a Touch ID proof
//                            (or a new SSO sign-in on devices without one). Short values for demos.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DpopError, currentNonce, jwkThumbprint, sha256b64url, verifyDpop, verifyPresence } from './dpop.mjs';
import { authorizePage, challengePage, dashboardPage, layout } from './pages.mjs';
import { MOCK_GEO, POSTURE_FLOOR, evaluate } from './rules.mjs';
import { verifyZta } from './posture.mjs';
import { consoleAction, consolePage, falconPosture, mockFalconApi, seedFalconHost } from './falcon.mjs';
import { nextTurn, writeTurn } from './fake-model.mjs';
import { db, findDeviceByJkt, save } from './store.mjs';
import { requestJti, signResponse, signingJwk } from './response-signing.mjs';
import { findTool, listTools } from './tools.mjs';
import { shortCode } from '../plugin/bridge/util.mjs'; // same device-code format as the plugin

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const AUTO = process.env.MOCK_AUTO_APPROVE === '1';
const TRUST_IP_HEADER = process.env.MOCK_TRUST_IP_HEADER === '1';
const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL ?? 300);
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL ?? 43200);
const CHALLENGE_TTL = 120;
const POLICY_FILE = process.env.MOCK_POLICY_FILE ?? new URL('./policy.json', import.meta.url);
const UPSTREAM_KEY = process.env.UPSTREAM_ANTHROPIC_API_KEY;
const UPSTREAM_URL = (process.env.UPSTREAM_ANTHROPIC_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
// Without an upstream key the gateway answers with a canned reply, so the flow works for free.
const LLM_FAKE = process.env.MOCK_LLM_FAKE === '1' || !UPSTREAM_KEY;
const FINGERPRINT_MODE = process.env.MOCK_FINGERPRINT ?? 'enforce';
const UNLOCK_TTL = Number(process.env.UNLOCK_TTL ?? 28800);
const FALCON_CROSSCHECK = (process.env.FALCON_CROSSCHECK ?? '1') === '1';
const CAEP_SECRET = process.env.CAEP_SECRET ?? 'mock-caep-secret';
const CAEP_COMPLIANCE = 'https://schemas.openid.net/secevent/caep/event-type/device-compliance-change';
const HOOK_MAX_AGE_S = 120;

const ERR_CHALLENGE = -32010;
const ERR_DENIED = -32011;

const now = () => Math.floor(Date.now() / 1000);
const token = () => randomBytes(32).toString('base64url');
const stable = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
const actionHash = (tool, args) => sha256b64url(stable({ tool, arguments: args ?? {} }));
const toolDefinitionHash = (t) => sha256b64url(stable({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
const globRe = (p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

const loadPolicy = () => {
  const raw = readFileSync(POLICY_FILE, 'utf8');
  return { policy: JSON.parse(raw), etag: `"${createHash('sha256').update(raw).digest('hex').slice(0, 16)}"` };
};

// ---------------- http helpers ----------------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  const payload = Buffer.from(isJson ? JSON.stringify(body) : body);
  writeSigned(res, status, { 'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...headers }, payload);
}

/** Write a response; responses to DPoP-signed requests carry HY-Response-Signature. */
function writeSigned(res, status, headers, payload) {
  const h = { 'DPoP-Nonce': currentNonce(), 'Cache-Control': 'no-store', ...headers };
  if (res.hyJti) h['HY-Response-Signature'] = signResponse(res.hyJti, status, payload);
  res.writeHead(status, h);
  res.end(payload);
}

/** Pages call our endpoints with fetch (Accept: application/json) so the tab's history
 * stays at one entry, which lets the final page close itself (window.close()). */
const wantsJson = (req) => (req.headers.accept ?? '').includes('application/json');

const redirect = (res, url) => {
  res.writeHead(302, { Location: url });
  res.end();
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const form = (buf) => Object.fromEntries(new URLSearchParams(buf.toString('utf8')));

function clientIp(req) {
  if (TRUST_IP_HEADER && req.headers['x-mock-client-ip']) return req.headers['x-mock-client-ip'];
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

function dpopFailure(res, e) {
  send(res, 401,{ error: e.error, error_description: e.message }, {
    'WWW-Authenticate': `DPoP error="${e.error}", error_description="${e.message}", algs="ES256"`,
  });
}

/** Authenticate a resource request: DPoP-bound access token + proof. */
async function authenticate(req, body, path) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('DPoP ')) throw new DpopError('invalid_token', 'DPoP access token required');
  const accessToken = auth.slice(5);
  const t = db.access_tokens[accessToken];
  if (!t || t.exp < now()) throw new DpopError('invalid_token', 'unknown or expired token');
  const { claims, jkt } = verifyDpop({
    proof: req.headers.dpop,
    method: req.method,
    url: `${PUBLIC_URL}${path}`,
    accessToken,
    body,
  });
  if (jkt !== t.jkt) {
    const e = new DpopError('invalid_token', 'token is bound to a different key');
    e.presentedJkt = jkt;
    throw e;
  }
  const device = db.devices[t.device_id];
  if (!device || device.revoked_at) throw new DpopError('invalid_token', 'device revoked');
  checkFingerprint(req, device, claims);
  const posture = await checkPosture(req, device, claims);
  const presence = verifyPresence(req.headers['hy-presence-proof'], claims, device.presence_jkt);
  return { device, user: db.users[t.user_id], claims, presence, posture };
}

/**
 * EDR posture from the CrowdStrike ZTA token (HY-Posture-ZTA), bound to this request by
 * the `ztah` proof claim. The agent ID is pinned on first sight: a token from another
 * host (copied file) is invalid for this device.
 * Returns { status: 'ok'|'stale'|'missing'|'invalid', score, reason?, age_minutes }.
 */
async function checkPosture(req, device, claims) {
  const token = req.headers['hy-posture-zta'];
  let posture;
  if (!token) {
    if (claims.ztah) throw new DpopError('invalid_dpop_proof', 'posture token missing but bound in proof');
    posture = { status: 'missing', score: null, reason: null, age_minutes: null };
  } else {
    if (sha256b64url(token) !== claims.ztah) throw new DpopError('invalid_dpop_proof', 'posture token does not match proof');
    const z = verifyZta(token);
    let status = z.ok ? (z.stale ? 'stale' : 'ok') : 'invalid';
    let reason = z.reason;
    if (z.ok) {
      device.zta_aid ??= z.aid; // first sight pins the CrowdStrike agent ID to this device
      if (device.zta_aid !== z.aid) {
        status = 'invalid';
        reason = 'ZTA token belongs to another CrowdStrike host';
      }
    }
    posture = {
      status,
      score: z.score ?? null,
      score_file: z.score ?? null,
      score_cloud: null,
      reason: reason ?? null,
      aid: z.aid ?? null,
      signature: z.signature ?? null,
      age_minutes: z.iat ? Math.floor((Date.now() / 1000 - z.iat) / 60) : null,
    };
    // Server-to-server confirmation by agent ID. The lower score wins; containment blocks.
    if (status !== 'invalid' && FALCON_CROSSCHECK) {
      if (!process.env.FALCON_BASE_URL) seedFalconHost(z.aid, z.cid, z.score); // mock: sensor reported to "cloud"
      try {
        const cloud = await falconPosture(`${PUBLIC_URL}/mock-falcon`, z.aid);
        posture.score_cloud = cloud.score;
        if (cloud.score !== null) posture.score = Math.min(posture.score, cloud.score);
        if (!cloud.known) {
          posture.status = 'unknown';
          posture.reason = 'host unknown to CrowdStrike';
        }
        if (cloud.contained) {
          posture.status = 'compromised';
          posture.reason = 'host contained by the security team (CrowdStrike)';
        }
      } catch (e) {
        posture.status = 'unknown';
        posture.reason = `CrowdStrike unreachable (${e.message})`;
      }
    }
  }
  // A pushed EDR alert (CAEP) overrides everything until it's resolved.
  if (device.edr_alert) {
    posture.status = 'compromised';
    posture.reason = device.edr_alert.reason;
  }
  posture.os = claims.osp ?? null;
  const prev = device.posture;
  if (prev && (prev.score !== posture.score || prev.status !== posture.status)) {
    db.events.push({
      event_id: randomUUID(),
      type: 'posture_changed',
      ts: new Date().toISOString(),
      source: 'gateway',
      device_id: device.id,
      data: { before: { score: prev.score, status: prev.status }, after: { score: posture.score, status: posture.status }, reason: posture.reason },
    });
  }
  device.posture = { ...posture, checked_at: new Date().toISOString() };
  return posture;
}

/**
 * Device fingerprint (dfp claim) and client context (HY-Client-Context, bound by ctxh).
 * Same key + different machine = the key was copied (software keys) -> reject as theft.
 * Context changes (Claude Code / OS updates) are only logged.
 */
function checkFingerprint(req, device, claims) {
  const header = req.headers['hy-client-context'];
  if (header) {
    const json = Buffer.from(header, 'base64url').toString('utf8');
    if (sha256b64url(json) !== claims.ctxh) throw new DpopError('invalid_dpop_proof', 'client context does not match proof');
    const ctx = JSON.parse(json);
    const prev = device.context;
    const changed = prev && ['os_version', 'kernel', 'hostname', 'os_user'].filter((k) => prev[k] !== ctx[k]);
    const clientChanged = prev?.client?.version && ctx.client?.version && prev.client.version !== ctx.client.version;
    if (changed?.length || clientChanged) {
      db.events.push({
        event_id: randomUUID(),
        type: 'client_context_changed',
        ts: new Date().toISOString(),
        source: 'gateway',
        device_id: device.id,
        data: { fields: [...(changed ?? []), ...(clientChanged ? ['client.version'] : [])], before: prev, after: ctx },
      });
    }
    // keep the last known Claude Code version even when a request carries none
    device.context = { ...ctx, client: ctx.client ?? prev?.client ?? null };
  }
  if (!device.fingerprint) return; // device registered before fingerprints existed
  if (claims.dfp === device.fingerprint.hash) return;
  device.fingerprint_mismatch_at = new Date().toISOString();
  if (FINGERPRINT_MODE !== 'enforce') return;
  const e = new DpopError('invalid_token', claims.dfp ? 'same key used from a different machine (device fingerprint changed)' : 'device fingerprint missing');
  e.theft = true;
  throw e;
}

function haversineKm(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Record the request's network on the device and compute travel speed. */
function observeNetwork(device, ip) {
  const known = device.ips.some((i) => i.ip === ip);
  let travelKmh = null;
  const prev = device.last_ip && MOCK_GEO[device.last_ip];
  const cur = MOCK_GEO[ip];
  if (prev && cur && device.last_ip !== ip) {
    const hours = Math.max((Date.now() - device.last_seen_ms) / 3_600_000, 1 / 3600);
    travelKmh = haversineKm(prev, cur) / hours;
  }
  return { known, travelKmh, geo: cur ?? null };
}

function touchNetwork(device, ip) {
  const entry = device.ips.find((i) => i.ip === ip);
  if (entry) entry.last_seen = new Date().toISOString();
  else device.ips.push({ ip, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() });
  device.last_ip = ip;
  device.last_seen_ms = Date.now();
}

// ---------------- routes ----------------

const routes = {
  'GET /.well-known/hy-platform': (req, res) =>
    send(res, 200, {
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/authorize`,
      token_endpoint: `${PUBLIC_URL}/token`,
      gateway_url: `${PUBLIC_URL}/mcp`,
      policy_endpoint: `${PUBLIC_URL}/v1/policy`,
      events_endpoint: `${PUBLIC_URL}/v1/events`,
      challenges_endpoint: `${PUBLIC_URL}/v1/challenges`,
      llm_gateway_url: `${PUBLIC_URL}/llm`,
      response_signing_jwk: signingJwk,
      // Can auto mode's server-side safety checks pass through this gateway? Only when it
      // forwards to Anthropic's API unchanged; the scripted mock model can't do them.
      llm_auto_mode_server: !LLM_FAKE,
      dpop_signing_alg_values_supported: ['ES256'],
    }),

  'GET /authorize': (req, res, url) => {
    const p = Object.fromEntries(url.searchParams);
    const missing = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'dpop_jkt'].filter((k) => !p[k]);
    if (missing.length || p.code_challenge_method !== 'S256' || p.response_type !== 'code')
      return send(res, 400, `<h1>Bad request</h1><p>missing/invalid: ${missing.join(', ') || 'method'}</p>`);
    const r = new URL(p.redirect_uri);
    if (r.hostname !== '127.0.0.1' || r.protocol !== 'http:')
      return send(res, 400, '<h1>redirect_uri must be a loopback address</h1>');
    const id = randomUUID();
    db.auth_requests[id] = { ...p, id, short_code: shortCode(p.dpop_jkt), exp: now() + 600 };
    if (AUTO) return approveLogin(res, db.auth_requests[id], 'dev@company.com');
    send(res, 200, authorizePage(db.auth_requests[id]));
  },

  'POST /authorize/decision': async (req, res) => {
    const f = form(await readBody(req));
    const ar = db.auth_requests[f.request_id];
    if (!ar || ar.exp < now()) return send(res, 400, '<h1>Request expired, start again from Claude Code</h1>');
    delete db.auth_requests[f.request_id];
    if (f.decision === 'deny' || !f.email) {
      const u = new URL(ar.redirect_uri);
      u.search = new URLSearchParams({ error: 'access_denied', state: ar.state }).toString();
      return wantsJson(req) ? send(res, 200, { redirect: u.toString() }) : redirect(res, u.toString());
    }
    approveLogin(res, ar, f.email, wantsJson(req));
  },

  'POST /token': async (req, res) => {
    const body = await readBody(req);
    const f = form(body);
    let proof;
    try {
      proof = verifyDpop({ proof: req.headers.dpop, method: 'POST', url: `${PUBLIC_URL}/token` });
    } catch (e) {
      if (e instanceof DpopError) return send(res, 400, { error: e.error, error_description: e.message });
      throw e;
    }
    const ip = clientIp(req);

    if (f.grant_type === 'authorization_code') {
      const c = db.codes[f.code];
      delete db.codes[f.code]; // single use
      if (!c || c.exp < now()) return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
      if (c.client_id !== f.client_id || c.redirect_uri !== f.redirect_uri)
        return send(res, 400, { error: 'invalid_grant', error_description: 'client/redirect mismatch' });
      if (sha256b64url(f.code_verifier ?? '') !== c.code_challenge)
        return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' });
      if (proof.jkt !== c.dpop_jkt)
        return send(res, 400, { error: 'invalid_dpop_proof', error_description: 'key differs from dpop_jkt' });

      let presence_jkt = null;
      let presence_jwk = null;
      if (f.presence_jwk) {
        const j = JSON.parse(f.presence_jwk);
        if (j.kty === 'EC' && j.crv === 'P-256' && j.x && j.y && !j.d) {
          presence_jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
          presence_jkt = jwkThumbprint(presence_jwk);
        }
      }
      let fingerprint = null;
      if (f.device_fingerprint) {
        const details = JSON.parse(f.device_fingerprint);
        if (sha256b64url(stable(details)) !== proof.claims.dfp)
          return send(res, 400, { error: 'invalid_request', error_description: 'device_fingerprint does not match proof' });
        fingerprint = { hash: proof.claims.dfp, details, set_at: new Date().toISOString() };
      }
      let device = findDeviceByJkt(proof.jkt);
      // A key already registered to one machine can't be re-registered from another:
      // that's a copied key, even if the person also has valid SSO credentials.
      if (device?.fingerprint && fingerprint && device.fingerprint.hash !== fingerprint.hash && FINGERPRINT_MODE === 'enforce') {
        device.fingerprint_mismatch_at = new Date().toISOString();
        recordRejection(req, '/token', 'sign-in with a key registered to a different machine', device.id, proof.jkt, undefined, true);
        return send(res, 400, { error: 'invalid_grant', error_description: 'this device key is registered to a different machine' });
      }
      if (!device) {
        device = { id: randomUUID(), jkt: proof.jkt, jwk: proof.jwk, ips: [], created_at: new Date().toISOString() };
        db.devices[device.id] = device;
      }
      Object.assign(device, {
        user_id: c.user_id,
        name: c.device_name,
        platform: c.platform,
        key_storage: c.key_storage,
        short_code: shortCode(proof.jkt),
        presence_jwk,
        presence_jkt,
        fingerprint: fingerprint ?? device.fingerprint ?? null,
        approved_at: new Date().toISOString(),
        revoked_at: null,
      });
      touchNetwork(device, ip); // the network the user approved from is trusted
      return issueTokens(res, device);
    }

    if (f.grant_type === 'refresh_token') {
      const rt = db.refresh_tokens[f.refresh_token];
      if (!rt || rt.exp < now()) return send(res, 400, { error: 'invalid_grant', error_description: 'bad refresh token' });
      if (rt.jkt !== proof.jkt) {
        recordRejection(req, '/token', 'refresh token bound to another key', rt.device_id, proof.jkt);
        return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token bound to another key' });
      }
      const device = db.devices[rt.device_id];
      if (!device || device.revoked_at) return send(res, 400, { error: 'invalid_grant', error_description: 'device revoked' });
      if (device.fingerprint && proof.claims.dfp !== device.fingerprint.hash && FINGERPRINT_MODE === 'enforce') {
        device.fingerprint_mismatch_at = new Date().toISOString();
        recordRejection(req, '/token', 'refresh from a different machine (device fingerprint changed)', device.id, proof.jkt, undefined, true);
        return send(res, 400, { error: 'invalid_grant', error_description: 'device fingerprint changed' });
      }
      // Session unlock: within the window refresh is silent; after it, only a human
      // (Touch ID presence proof over this same request) can extend the session.
      if ((rt.unlocked_until ?? 0) < now()) {
        if (!verifyPresence(req.headers['hy-presence-proof'], proof.claims, device.presence_jkt)) {
          return send(res, 400, {
            error: 'invalid_grant',
            error_description: device.presence_jkt ? 'unlock_required' : 'session expired, sign in again',
          });
        }
        rt.unlocked_until = now() + UNLOCK_TTL;
        db.events.push({ event_id: randomUUID(), type: 'session_unlocked', ts: new Date().toISOString(), source: 'gateway', device_id: device.id, data: { method: 'touch_id' } });
      }
      return issueTokens(res, device, f.refresh_token);
    }
    send(res, 400, { error: 'unsupported_grant_type' });
  },

  'GET /v1/policy': (req, res, url, ctx) => {
    const { policy, etag } = loadPolicy();
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag });
    send(res, 200, policy, { ETag: etag });
  },

  'POST /v1/events': (req, res, url, ctx) => {
    const { events } = JSON.parse(ctx.body.toString('utf8') || '{}');
    if (!Array.isArray(events)) return send(res, 400, { error: 'events must be an array' });
    for (const e of events.slice(0, 500)) {
      db.events.push({ ...e, device_id: ctx.device.id, received_at: new Date().toISOString() });
      noteSession(ctx.device, e.context?.claude_session_id);
      if (e.type === 'pre_tool_use' && e.data?.untrusted_content) {
        ctx.device.untrusted_at = e.ts;
        ctx.device.untrusted_what = [e.data.input?.domain, `(${e.data.tool})`].filter(Boolean).join(' ');
      }
    }
    save();
    send(res, 202, { accepted: Math.min(events.length, 500) });
  },

  'POST /mcp': (req, res, url, ctx) => gateway(req, res, ctx),

  // Pushed security events (OpenID Shared Signals / CAEP). Real deployments receive signed
  // SETs (RFC 8417) via push delivery (RFC 8935); the mock accepts JSON with a bearer secret.
  'POST /v1/signals/caep': async (req, res) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${CAEP_SECRET}`) return send(res, 401, { err: 'authentication_failed' });
    const set = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ev = set.events?.[CAEP_COMPLIANCE];
    if (!ev) return send(res, 400, { err: 'invalid_request', description: 'only device-compliance-change is supported' });
    const id = ev.subject?.id;
    const devices = Object.values(db.devices).filter((d) => d.zta_aid === id || d.id === id);
    for (const d of devices) {
      d.edr_alert = ev.current_status === 'not-compliant' ? { reason: `EDR alert: ${ev.reason_admin?.en ?? 'device not compliant'}`, at: new Date().toISOString(), source: set.iss } : null;
      db.events.push({ event_id: randomUUID(), type: d.edr_alert ? 'edr_alert' : 'edr_alert_resolved', ts: new Date().toISOString(), source: set.iss ?? 'caep', device_id: d.id, data: ev });
    }
    save();
    send(res, 202, { matched_devices: devices.length });
  },

  'GET /mock-falcon/console': (req, res) => send(res, 200, consolePage(layout)),

  'GET /': (req, res) => send(res, 200, dashboardPage(db)),
};

// Prefix routes
async function prefixRoute(req, res, url, path) {
  let m;
  if (path.startsWith('/mock-falcon/console/')) return consoleAction(req, res, path, { redirect, publicUrl: PUBLIC_URL, caepSecret: CAEP_SECRET });
  if (path.startsWith('/mock-falcon/') && (await mockFalconApi(req, res, url, path, { send, readBody }))) return true;
  if (path.startsWith('/llm/')) {
    const ctx = await authed(req, res, path, await readBody(req));
    if (!ctx) return true;
    await llmGateway(req, res, url, ctx);
    return true;
  }
  if ((m = path.match(/^\/v1\/challenges\/([\w-]+)$/)) && req.method === 'GET') {
    const ctx = await authed(req, res, path);
    if (!ctx) return true;
    const c = db.challenges[m[1]];
    if (!c || c.device_id !== ctx.device.id) return send(res, 404, { error: 'not_found' }), true;
    expireChallenge(c);
    return send(res, 200, { id: c.id, status: c.status, expires_at: c.expires_at, approved_by: c.approved_by ?? null }), true;
  }
  if ((m = path.match(/^\/challenge\/([\w-]+)$/)) && req.method === 'GET') {
    const c = db.challenges[m[1]];
    if (!c) return send(res, 404, '<h1>Unknown challenge</h1>'), true;
    expireChallenge(c);
    if (AUTO && c.status === 'pending') {
      c.status = 'approved'; // auto-approve mode: as if the owner signed in again
      c.approved_by = db.users[c.user_id]?.email ?? null;
      c.approved_at = new Date().toISOString();
    }
    return send(res, 200, challengePage(c)), true;
  }
  if ((m = path.match(/^\/challenge\/([\w-]+)\/(approve|deny)$/)) && req.method === 'POST') {
    // Approving needs a FRESH sign-in as the device's owner (mock SSO: pick the account).
    // Production: redirect to the IdP with prompt=login / max_age=0 (no existing session
    // counts), ideally with a passkey, and approve only for the same user.
    const c = db.challenges[m[1]];
    if (!c) return send(res, 404, '<h1>Unknown challenge</h1>'), true;
    expireChallenge(c);
    if (c.status === 'pending' && m[2] === 'deny') c.status = 'denied';
    if (c.status === 'pending' && m[2] === 'approve') {
      const email = new URLSearchParams((await readBody(req)).toString()).get('email');
      const owner = db.users[c.user_id]?.email;
      if (email !== owner) {
        const msg = `Signed in as ${email ?? 'nobody'}, but this device belongs to ${owner}. Not approved.`;
        return (wantsJson(req) ? send(res, 403, { error: msg }) : send(res, 403, challengePage(c, msg))), true;
      }
      c.status = 'approved';
      c.approved_by = email;
      c.approved_at = new Date().toISOString();
    }
    save();
    if (wantsJson(req)) return send(res, 200, { status: c.status, approved_by: c.approved_by ?? null }), true;
    return redirect(res, `/challenge/${c.id}`), true;
  }
  if ((m = path.match(/^\/admin\/devices\/([\w-]+)\/lock$/)) && req.method === 'POST') {
    // End the unlock window now: the next refresh needs Touch ID (or a new sign-in).
    const d = db.devices[m[1]];
    if (d) {
      for (const t of Object.values(db.refresh_tokens)) if (t.device_id === d.id) t.unlocked_until = 0;
      for (const [k, t] of Object.entries(db.access_tokens)) if (t.device_id === d.id) delete db.access_tokens[k];
      save();
    }
    return redirect(res, '/'), true;
  }
  if ((m = path.match(/^\/admin\/devices\/([\w-]+)\/revoke$/)) && req.method === 'POST') {
    const d = db.devices[m[1]];
    if (d) {
      d.revoked_at = new Date().toISOString();
      for (const [k, t] of Object.entries(db.access_tokens)) if (t.device_id === d.id) delete db.access_tokens[k];
      for (const [k, t] of Object.entries(db.refresh_tokens)) if (t.device_id === d.id) delete db.refresh_tokens[k];
      save();
    }
    return redirect(res, '/'), true;
  }
  return false;
}

function approveLogin(res, ar, email, json = false) {
  const userId = `u_${createHash('sha256').update(email).digest('hex').slice(0, 10)}`;
  db.users[userId] ??= { id: userId, email, name: email.split('@')[0] };
  const code = token();
  db.codes[code] = {
    client_id: ar.client_id,
    redirect_uri: ar.redirect_uri,
    code_challenge: ar.code_challenge,
    dpop_jkt: ar.dpop_jkt,
    user_id: userId,
    device_name: ar.device_name ?? 'unknown device',
    platform: ar.platform ?? 'unknown',
    key_storage: ar.key_storage ?? 'unknown',
    exp: now() + 60,
  };
  save();
  const u = new URL(ar.redirect_uri);
  u.search = new URLSearchParams({ code, state: ar.state }).toString();
  if (json) return send(res, 200, { redirect: u.toString() });
  redirect(res, u.toString());
}

function issueTokens(res, device, existingRefresh) {
  const access = token();
  db.access_tokens[access] = { device_id: device.id, user_id: device.user_id, jkt: device.jkt, exp: now() + ACCESS_TTL };
  let refresh = existingRefresh;
  if (!refresh) {
    // A fresh SSO sign-in is a human, so it starts an unlock window.
    refresh = token();
    db.refresh_tokens[refresh] = {
      device_id: device.id,
      user_id: device.user_id,
      jkt: device.jkt,
      exp: now() + REFRESH_TTL,
      unlocked_until: now() + UNLOCK_TTL,
    };
  }
  const unlockedUntil = db.refresh_tokens[refresh].unlocked_until ?? 0;
  save();
  const user = db.users[device.user_id];
  send(res, 200, {
    access_token: access,
    token_type: 'DPoP',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    unlock_expires_in: Math.max(0, unlockedUntil - now()),
    user: { id: user.id, email: user.email, name: user.name },
    device: { id: device.id, short_code: device.short_code, key_storage: device.key_storage },
  });
}

/** Remember Claude Code session IDs seen for a device (hooks, model requests, tool calls). */
function noteSession(device, sid) {
  if (!sid || typeof sid !== 'string') return;
  device.sessions ??= {};
  device.sessions[sid] = new Date().toISOString();
  const ids = Object.keys(device.sessions);
  if (ids.length > 50) delete device.sessions[ids.sort((a, b) => device.sessions[a].localeCompare(device.sessions[b]))[0]];
}

function expireChallenge(c) {
  if (c.status === 'pending' && Date.parse(c.expires_at) < Date.now()) c.status = 'expired';
}

async function authed(req, res, path, body = Buffer.alloc(0)) {
  try {
    return { ...(await authenticate(req, body, path)), body, headers: req.headers };
  } catch (e) {
    if (e instanceof DpopError) {
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^(DPoP|Bearer) /, '');
      recordRejection(req, path, e.message, db.access_tokens[token]?.device_id, e.presentedJkt, e.error, e.theft);
      return dpopFailure(res, e), null;
    }
    throw e;
  }
}

/**
 * Log refused credentials. A valid token or refresh token presented with another
 * key is the signature of token theft: flag the device it belongs to.
 */
function recordRejection(req, path, reason, victimDeviceId, presentedJkt, code, theftHint = false) {
  if (code === 'use_dpop_nonce') return; // normal protocol round-trip
  const victim = victimDeviceId ? db.devices[victimDeviceId] : null;
  const theft = Boolean(victim && (theftHint || (presentedJkt && presentedJkt !== victim.jkt)));
  if (theft) victim.theft_suspected_at = new Date().toISOString();
  db.rejections.push({
    ts: new Date().toISOString(),
    ip: clientIp(req),
    path,
    reason,
    theft_suspected: theft,
    victim_device_id: victim?.id ?? null,
    presented_key: presentedJkt ? shortCode(presentedJkt) : null,
  });
  save();
}

// ---------------- MCP gateway ----------------

/**
 * Was this tool call started by Claude Code? Its PreToolUse hook records the session ID
 * and the hash of {tool, arguments}; the bridge puts that into the signed proof (claim
 * `hook`). A call without a matching, recent hook record was made some other way,
 * e.g. by malware driving the signer directly. Evidence, not proof.
 */
function hookSignals(ctx, actionHash) {
  const h = ctx.claims.hook;
  const correlated = Boolean(h && h.ah === actionHash && Math.abs(Date.now() / 1000 - h.ts) <= HOOK_MAX_AGE_S);
  if (correlated) noteSession(ctx.device, h.sid);
  return {
    hook_correlated: correlated,
    claude_session_id: correlated ? h.sid : null,
    session_known: correlated && Boolean(ctx.device.sessions?.[h.sid]),
  };
}

function gateway(req, res, ctx) {
  let msg;
  try {
    msg = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const reply = (result, headers) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result }, headers);
  const fail = (code, message, data) => send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code, message, data } });

  if (msg.method === 'initialize') {
    const sid = randomUUID();
    db.sessions[sid] = { device_id: ctx.device.id, created_at: new Date().toISOString() };
    return reply(
      {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mock-gateway', version: '0.1.0' },
      },
      { 'Mcp-Session-Id': sid },
    );
  }
  const sid = req.headers['mcp-session-id'];
  if (!sid || db.sessions[sid]?.device_id !== ctx.device.id) return send(res, 404, { error: 'unknown session' });
  if (msg.id === undefined) return send(res, 202, '');

  if (msg.method === 'tools/list') {
    // Hidden tools aren't even listed: a modified client can't discover them.
    const { policy } = loadPolicy();
    const hidden = (n) => policy.tools.find((r) => globRe(r.match).test(n))?.action === 'hide';
    return reply({ tools: listTools().filter((t) => !hidden(t.name)) });
  }
  if (msg.method !== 'tools/call') return fail(-32601, `method not found: ${msg.method}`);

  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  const tool = findTool(name);
  if (!tool) return fail(-32602, `unknown tool ${name}`);
  const { run: _run, ...definition } = tool;

  const { policy } = loadPolicy();
  const orgRule = policy.tools.find((r) => globRe(r.match).test(name));
  const tier = orgRule?.tier ?? (tool.annotations?.destructiveHint ? 'destructive' : tool.annotations?.readOnlyHint ? 'read' : 'write');
  const approval = orgRule?.approval ?? (orgRule?.action === 'ask' ? 'confirm' : policy.approval_defaults?.[tier] ?? 'none');
  // Argument rules: the bridge checks them before sending, but a modified client could
  // skip that, so the gateway enforces them again.
  let argumentViolation = null;
  for (const r of policy.argument_rules ?? []) {
    if (!globRe(r.tool).test(name)) continue;
    const v = args[r.argument];
    const bad = (Array.isArray(v) ? v : v === undefined ? [] : [v]).find((x) => !new RegExp(r.pattern).test(String(x)));
    if (bad !== undefined) argumentViolation = r.message ?? `argument ${r.argument}=${bad} not allowed by policy`;
  }
  const ip = clientIp(req);
  const net = observeNetwork(ctx.device, ip);
  const hash = actionHash(name, args);

  let approved = null;
  const cid = req.headers['hy-challenge-id'];
  if (cid) {
    const c = db.challenges[cid];
    if (c) expireChallenge(c);
    if (c && c.device_id === ctx.device.id && c.action_hash === hash && c.status === 'approved' && !c.used_at) approved = c;
  }

  const signals = {
    tool: name,
    tier,
    org_action: orgRule?.action === 'ask' ? 'allow' : orgRule?.action ?? policy.default_action ?? 'allow',
    approval,
    argument_violation: argumentViolation,
    // Admin-pinned tool definitions (policy.pinned): an MCP server that changed a tool's
    // description or schema since it was reviewed is refused here, not just hidden locally.
    definition_changed: Boolean(policy.pinned?.[name] && policy.pinned[name] !== toolDefinitionHash(definition)),
    presence_verified: ctx.presence,
    presence_capable: Boolean(ctx.device.presence_jkt),
    key_storage: ctx.device.key_storage,
    ip,
    ip_known: net.known,
    geo: net.geo,
    travel_kmh: net.travelKmh,
    untrusted_content_minutes_ago: ctx.device.untrusted_at
      ? Math.floor((Date.now() - Date.parse(ctx.device.untrusted_at)) / 60_000)
      : null,
    untrusted_source: ctx.device.untrusted_what ?? null,
    untrusted_window_minutes: policy.untrusted_content?.window_minutes ?? 10,
    approved_challenge: Boolean(approved),
    ...hookSignals(ctx, hash),
    user_idle_minutes: typeof ctx.claims.idle === 'number' ? Math.floor(ctx.claims.idle / 60) : null,
    posture_status: ctx.posture.status,
    posture_score: ctx.posture.score,
    posture_reason: ctx.posture.reason,
    os_posture: ctx.posture.os,
  };
  const { decision, reasons } = evaluate(signals);
  const record = { id: randomUUID(), ts: new Date().toISOString(), device_id: ctx.device.id, user_id: ctx.device.user_id, tool: name, decision, reasons, signals };
  db.decisions.push(record);

  if (decision === 'allow') {
    if (approved) approved.used_at = new Date().toISOString(); // single use
    touchNetwork(ctx.device, ip);
    save();
    const out = tool.run(args);
    if (orgRule?.untrusted_source) {
      // Its result is outside content (emails, tickets, web pages): later write/destructive
      // calls get a human check. Marked here, so it doesn't depend on the client.
      ctx.device.untrusted_at = new Date().toISOString();
      ctx.device.untrusted_what = name;
      save();
    }
    return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
  }
  if (decision === 'deny') {
    save();
    return fail(ERR_DENIED, 'denied', { decision_id: record.id, reasons });
  }
  const id = randomUUID();
  db.challenges[id] = {
    id,
    device_id: ctx.device.id,
    device_name: ctx.device.name,
    device_code: ctx.device.short_code,
    key_storage: ctx.device.key_storage,
    user_id: ctx.device.user_id,
    tool: name,
    description: tool.description,
    tier,
    arguments: args,
    ip,
    geo: net.geo,
    claude_session_id: signals.claude_session_id,
    posture_score: signals.posture_score,
    action_hash: hash,
    reasons,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + CHALLENGE_TTL * 1000).toISOString(),
    decision_id: record.id,
  };
  save();
  fail(ERR_CHALLENGE, 'challenge_required', {
    decision_id: record.id,
    challenge: { id, approve_url: `${PUBLIC_URL}/challenge/${id}`, expires_in: CHALLENGE_TTL, reasons },
  });
}

// ---------------- LLM gateway ----------------
// Same DPoP checks as /mcp (done in authed()), then forward to Anthropic with the
// company key. The device's token never leaves the platform.

const DROP_UP = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'dpop', 'accept-encoding', 'hy-presence-proof']);
const DROP_DOWN = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

async function llmGateway(req, res, url, ctx) {
  const upstreamPath = url.pathname.slice('/llm'.length) + url.search;
  let model = null;
  let stream = false;
  let tools = [];
  try {
    const b = JSON.parse(ctx.body.toString('utf8') || '{}');
    model = b.model ?? null;
    stream = Boolean(b.stream);
    tools = (b.tools ?? []).map((t) => t.name).filter(Boolean);
  } catch {}
  db.events.push({
    event_id: randomUUID(),
    type: 'llm_request',
    ts: new Date().toISOString(),
    source: 'gateway',
    device_id: ctx.device.id,
    data: { path: url.pathname, model, stream, bytes: ctx.body.length, session: req.headers['x-claude-code-session-id'] ?? null, tools: tools.length, mcp_tools: tools.filter((n) => n.startsWith('mcp__')) },
  });
  touchNetwork(ctx.device, clientIp(req));
  noteSession(ctx.device, req.headers['x-claude-code-session-id']);
  save();

  // A compromised laptop loses the model too, not just the tools.
  const p = ctx.posture;
  if (p.status === 'invalid' || p.status === 'compromised' || (p.score !== null && p.score < POSTURE_FLOOR)) {
    const why = p.status === 'invalid' || p.status === 'compromised' ? p.reason : `CrowdStrike posture score ${p.score} is below ${POSTURE_FLOOR}`;
    return send(res, 403, { type: 'error', error: { type: 'permission_error', message: `hy-guard: device blocked by EDR posture: ${why}` } });
  }
  if (LLM_FAKE) return fakeLlm(res, url.pathname, stream, model, ctx);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_UP.has(k)) headers[k] = v;
  headers['x-api-key'] = UPSTREAM_KEY;
  const up = await fetch(`${UPSTREAM_URL}${upstreamPath}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : ctx.body,
  });
  const out = {};
  up.headers.forEach((v, k) => {
    if (!DROP_DOWN.has(k)) out[k] = v;
  });
  // Streams relay unbuffered and unsigned (a stream can't be verified before it's shown);
  // everything else is buffered and signed.
  if ((up.headers.get('content-type') ?? '').includes('text/event-stream')) {
    res.writeHead(up.status, { ...out, 'DPoP-Nonce': currentNonce() });
    if (up.body) for await (const chunk of up.body) res.write(chunk);
    return res.end();
  }
  writeSigned(res, up.status, out, Buffer.from(await up.arrayBuffer()));
}

/** Scripted model (fake-model.mjs) instead of a real LLM. */
function fakeLlm(res, path, stream, model, ctx) {
  if (!path.endsWith('/v1/messages'))
    return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'mock model: only /v1/messages' } });
  let body = {};
  try {
    body = JSON.parse(ctx.body.toString('utf8') || '{}');
  } catch {}
  // MOCK_LLM_DUMP=<dir>: keep each model request (debugging the scripted model)
  if (process.env.MOCK_LLM_DUMP) {
    mkdirSync(process.env.MOCK_LLM_DUMP, { recursive: true });
    writeFileSync(join(process.env.MOCK_LLM_DUMP, `${Date.now()}-${randomUUID().slice(0, 6)}.json`), JSON.stringify({ headers: ctx.headers, body }, null, 2));
  }
  writeTurn(res, nextTurn(body), { stream, model, nonce: currentNonce(), writeJson: (m) => send(res, 200, m) });
}

// ---------------- server ----------------

const PROTECTED = new Set(['GET /v1/policy', 'POST /v1/events', 'POST /mcp']);

createServer(async (req, res) => {
  if (req.headers.dpop) res.hyJti = requestJti(req.headers.dpop); // responses to signed requests get signed
  const url = new URL(req.url, PUBLIC_URL);
  const path = url.pathname;
  const key = `${req.method} ${path}`;
  try {
    const handler = routes[key];
    if (handler) {
      if (PROTECTED.has(key)) {
        const ctx = await authed(req, res, path, await readBody(req));
        if (!ctx) return;
        return await handler(req, res, url, ctx);
      }
      return await handler(req, res, url);
    }
    if (await prefixRoute(req, res, url, path)) return;
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server_error', error_description: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock platform on ${PUBLIC_URL}  (dashboard: ${PUBLIC_URL}/)`);
  if (AUTO) console.log('MOCK_AUTO_APPROVE=1: sign-ins and challenges are approved automatically');
  console.log(LLM_FAKE ? 'LLM gateway: scripted mock model (set UPSTREAM_ANTHROPIC_API_KEY for a real one)' : `LLM gateway: forwarding to ${UPSTREAM_URL}`);
});
