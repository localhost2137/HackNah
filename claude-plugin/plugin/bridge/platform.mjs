// PlatformClient: the ONLY place the bridge talks to the platform backend.
// Endpoints come from the discovery document, so the real backend only has to
// serve GET /.well-known/hy-platform with its own URLs. See docs/BACKEND_CONTRACT.md.

import { spawn } from 'node:child_process';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.mjs';
import { createPresenceProof, createProof } from './dpop.mjs';
import { clientContext, deviceFingerprint, deviceFingerprintHash, encodeContext, userIdleSeconds } from './fingerprint.mjs';
import { osPosture, ztaToken } from './posture.mjs';
import { info, warn } from './log.mjs';
import { acquireLock, b64url, jwkThumbprint, randomId, readJson, sha256, sha256b64url, shortCode, writeJson } from './util.mjs';

/** A platform response failed verification: someone may be in the middle. */
export class ResponseSignatureError extends Error {
  constructor(msg) {
    super(`platform response failed verification (${msg}); possible man-in-the-middle`);
    this.code = 'response_tampered';
  }
}

const RESPONSE_MAX_SKEW_S = 300;
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export class AuthRequiredError extends Error {
  constructor(msg = 'not signed in') {
    super(msg);
    this.code = 'auth_required';
  }
}

const LOGIN_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_S = 30;

export class PlatformClient {
  constructor(keys) {
    this.keys = keys;
    this.discovery = null;
    this.nonces = new Map(); // origin -> latest DPoP-Nonce
    this.loginPromise = null;
    this.lastLoginUrl = null;
    this.lastRejection = null; // why the platform last refused our credentials
    this.client = null; // { name, version } of Claude Code, once known
    this.onAuthChange = () => {};
  }

  async discover() {
    if (this.discovery) return this.discovery;
    requireSecureUrl(config.platformUrl);
    const res = await fetch(`${config.platformUrl}/.well-known/hy-platform`);
    if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
    const d = await res.json();
    // Every endpoint, not just the base URL: a tampered discovery document must not
    // be able to send tokens over plain HTTP.
    for (const [k, v] of Object.entries(d)) if (k.endsWith('_endpoint') || k.endsWith('_url')) requireSecureUrl(v);
    this.responseKey = this.#pinResponseKey(d.response_signing_jwk);
    this.discovery = d;
    return d;
  }

  /**
   * Pin the platform's response-signing key, like SSH known_hosts: an explicit
   * HY_PLATFORM_KEY_JKT wins; otherwise the first key seen is pinned. A different key,
   * or a platform that stops publishing one after it was pinned, is refused.
   */
  #pinResponseKey(jwk) {
    if (config.responseSignatures === 'off') return null;
    const pins = readJson(config.paths.platformKeyPin, {});
    const pinned = config.platformKeyJkt || pins[config.platformUrl];
    if (!jwk) {
      if (pinned || config.responseSignatures === 'require')
        throw new ResponseSignatureError('platform no longer publishes its response-signing key');
      return null;
    }
    const { kty, crv, x, y } = jwk;
    const jkt = jwkThumbprint({ kty, crv, x, y });
    if (pinned && pinned !== jkt)
      throw new ResponseSignatureError(
        `platform signing key changed (pinned ${pinned.slice(0, 12)}…, got ${jkt.slice(0, 12)}…). If the platform really rotated its key: node main.mjs pins-reset --platform`,
      );
    if (!pinned) writeJson(config.paths.platformKeyPin, { ...pins, [config.platformUrl]: jkt });
    return createPublicKey({ key: { kty, crv, x, y }, format: 'jwk' });
  }

  /** Verify HY-Response-Signature over status + body, bound to our request's jti. */
  async #verifyResponse(res, jti) {
    if (!this.responseKey) return res;
    // A stream can't be verified before it's relayed; streams are documented as unsigned.
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return res;
    const body = Buffer.from(await res.arrayBuffer());
    const sig = res.headers.get('hy-response-signature');
    if (!sig) throw new ResponseSignatureError('unsigned response');
    const parts = sig.split('.');
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new ResponseSignatureError('malformed signature');
    }
    const ok =
      parts.length === 3 &&
      verifySignature(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: this.responseKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      );
    if (!ok) throw new ResponseSignatureError('bad signature');
    if (claims.jti !== jti) throw new ResponseSignatureError('signature belongs to another request');
    if (claims.status !== res.status) throw new ResponseSignatureError('status changed');
    if (claims.bh !== sha256b64url(body)) throw new ResponseSignatureError('body changed');
    if (Math.abs(Date.now() / 1000 - claims.iat) > RESPONSE_MAX_SKEW_S) throw new ResponseSignatureError('stale signature');
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  // ---------- token storage (shared by all bridge processes on this device) ----------

  get tokens() {
    const t = readJson(config.paths.tokens);
    // Tokens issued for another platform or another key are useless; ignore them.
    // HY_SIMULATE_STOLEN=1 (demo only) sends them anyway, like an attacker's patched client.
    if (!t || t.platform_url !== config.platformUrl) return null;
    if (t.jkt !== this.keys.thumbprint && !config.simulateStolen) return null;
    return t;
  }

  saveTokens(resp) {
    const now = Math.floor(Date.now() / 1000);
    writeJson(config.paths.tokens, {
      platform_url: config.platformUrl,
      jkt: this.keys.thumbprint,
      access_token: resp.access_token,
      access_expires_at: now + (resp.expires_in ?? 300),
      refresh_token: resp.refresh_token ?? this.tokens?.refresh_token,
      // After this, a refresh needs Touch ID (or a new sign-in without a presence key).
      unlock_expires_at: now + (resp.unlock_expires_in ?? 0),
      user: resp.user ?? this.tokens?.user,
      device: resp.device ?? this.tokens?.device,
    });
  }

  clearTokens() {
    writeJson(config.paths.tokens, {});
    this.onAuthChange(false);
  }

  isSignedIn() {
    return Boolean(this.tokens?.refresh_token || this.tokens?.access_token);
  }

  // ---------- DPoP-protected requests ----------

  /**
   * Fetch with DPoP. Handles server nonces, token refresh and presence proofs.
   * @param {string} url
   * @param {object} o
   * @param {string} [o.method]
   * @param {string|Buffer} [o.body]
   * @param {object} [o.headers]
   * @param {boolean|string} [o.presence]  add a Touch ID proof; a string is the prompt reason
   * @param {boolean} [o.auth]             send the access token (false for /token)
   * @param {object} [o.client]            Claude Code {name, version} for the client context
   * @param {object} [o.claims]            extra signed claims (e.g. hook correlation)
   */
  async fetch(url, { method = 'GET', body, headers = {}, presence = false, auth = true, client, claims: extraClaims } = {}) {
    if (!this.discovery) await this.discover(); // pins the response-signing key first
    const ctx = encodeContext({ ...clientContext(client ?? this.client), key_storage: this.keys.storage });
    const zta = ztaToken();
    const origin = new URL(url).origin;
    const wantPresence = Boolean(presence) && this.keys.hasPresence();
    // A Touch ID signature over a request that then bounces for a nonce would prompt twice.
    if (wantPresence && !this.nonces.has(origin)) await this.#primeNonce(origin);
    let refreshed = false;
    // Up to: nonce round-trip, refresh, nonce again, final try.
    for (let attempt = 0; attempt < 4; attempt++) {
      let accessToken;
      if (auth) accessToken = await this.#accessToken();
      const { proof, claims } = await createProof(this.keys, {
        method,
        url,
        accessToken,
        body,
        nonce: this.nonces.get(origin),
        extra: {
          dfp: deviceFingerprintHash(),
          ctxh: ctx.hash,
          idle: userIdleSeconds() ?? undefined,
          ztah: zta ? sha256b64url(zta) : undefined, // binds the EDR posture token to this request
          osp: osPosture() ?? undefined, // built-in OS posture (FileVault, SIP, Gatekeeper, firewall)
          ...extraClaims,
        },
      });
      const h = { ...headers, DPoP: proof, 'HY-Client-Context': ctx.header };
      if (zta) h['HY-Posture-ZTA'] = zta;
      if (accessToken) h.Authorization = `DPoP ${accessToken}`;
      if (wantPresence) {
        const reason = typeof presence === 'string' ? presence : 'confirm a sensitive action';
        h['HY-Presence-Proof'] = await createPresenceProof(this.keys, claims, reason);
      }
      // Demo only: the mock honours this with MOCK_TRUST_IP_HEADER=1 (pretend to be elsewhere).
      if (config.simulateIp) h['X-Mock-Client-IP'] = config.simulateIp;

      const res = await this.#verifyResponse(await fetch(url, { method, body, headers: h }), claims.jti);
      const nonce = res.headers.get('dpop-nonce');
      if (nonce) this.nonces.set(origin, nonce);
      // Authorization servers signal a missing nonce with 400 (RFC 9449 §8).
      if (res.status === 400 && nonce) {
        const err = await res.clone().json().catch(() => ({}));
        if (err.error === 'use_dpop_nonce') continue;
      }
      if (res.status !== 401) return res;

      const challenge = res.headers.get('www-authenticate') ?? '';
      if (auth && !challenge.includes('use_dpop_nonce'))
        this.lastRejection = /error_description="([^"]*)"/.exec(challenge)?.[1] ?? (challenge || `HTTP ${res.status}`);
      if (challenge.includes('use_dpop_nonce') && nonce) continue; // retry with fresh nonce
      if (auth && challenge.includes('invalid_token') && !refreshed) {
        refreshed = true;
        await this.#refresh(true).catch((e) => {
          if (e.code === 'unlock_cancelled') throw e; // keep the session; the user just said no
        });
        continue;
      }
      if (auth) {
        warn('platform rejected credentials', { url, challenge });
        this.clearTokens();
        throw new AuthRequiredError();
      }
      return res;
    }
    throw new Error('DPoP retry limit reached');
  }

  /** Any platform response carries a DPoP-Nonce; fetch one cheaply. */
  async #primeNonce(origin) {
    try {
      const res = await fetch(`${config.platformUrl}/.well-known/hy-platform`);
      const nonce = res.headers.get('dpop-nonce');
      if (nonce) this.nonces.set(origin, nonce);
    } catch {}
  }

  async #accessToken() {
    const t = this.tokens;
    if (!t) throw new AuthRequiredError();
    if (t.access_token && t.access_expires_at - REFRESH_SKEW_S > Date.now() / 1000) return t.access_token;
    await this.#refresh();
    return this.tokens.access_token;
  }

  /**
   * Refresh the access token. Inside the unlock window this is silent; after it, the
   * request carries a Touch ID proof (one prompt, even with several bridge processes,
   * thanks to the lock). Devices without a presence key must sign in again.
   */
  async #refresh(force = false) {
    const first = this.tokens;
    if (!first?.refresh_token) throw new AuthRequiredError();
    const release = await acquireLock(config.paths.refreshLock);
    try {
      const before = this.tokens; // another process may have refreshed while we waited
      if (!before?.refresh_token) throw new AuthRequiredError();
      if (before.access_token !== first.access_token) return;
      if (!force && before.access_expires_at - REFRESH_SKEW_S > Date.now() / 1000) return;

      const d = await this.discover();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: before.refresh_token,
        client_id: config.clientId,
      }).toString();
      const post = (presence) =>
        this.fetch(d.token_endpoint, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          auth: false,
          presence,
        });
      const canUnlock = config.presence && this.keys.hasPresence();
      const locked = (before.unlock_expires_at ?? 0) - REFRESH_SKEW_S < Date.now() / 1000;
      const UNLOCK_REASON = 'unlock company tools for Claude Code';

      let res;
      try {
        res = await post(canUnlock && locked ? UNLOCK_REASON : false);
        if (res.status === 400 && canUnlock && !locked) {
          const err = await res.clone().json().catch(() => ({}));
          if (err.error_description === 'unlock_required') res = await post(UNLOCK_REASON);
        }
      } catch (e) {
        if (e instanceof AuthRequiredError) throw e;
        const err = new Error(e.message);
        err.code = 'unlock_cancelled'; // Touch ID cancelled or failed; keep the session
        throw err;
      }
      if (!res.ok) {
        const latest = this.tokens;
        if (latest && latest.refresh_token !== before.refresh_token) return; // rotated by another process
        const err = await res.json().catch(() => ({}));
        this.lastRejection = err.error_description ?? `refresh failed: HTTP ${res.status}`;
        this.clearTokens();
        throw new AuthRequiredError(this.lastRejection);
      }
      this.saveTokens(await res.json());
    } finally {
      release();
    }
  }

  // ---------- login: OAuth code + PKCE, loopback redirect, key-bound via dpop_jkt ----------

  login() {
    this.loginPromise ??= this.#login().finally(() => (this.loginPromise = null));
    return this.loginPromise;
  }

  async #login() {
    const d = await this.discover();
    const verifier = randomId(32);
    const state = randomId(16);
    const { server, port, waitForCode } = await loopback(state);
    try {
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = new URL(d.authorization_endpoint);
      authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: b64url(sha256(verifier)),
        code_challenge_method: 'S256',
        dpop_jkt: this.keys.thumbprint,
        device_name: config.deviceName,
        key_storage: this.keys.storage,
        platform: process.platform,
      }).toString();
      this.lastLoginUrl = authUrl.toString();
      info('login started', { url: this.lastLoginUrl, code: shortCode(this.keys.thumbprint) });
      openBrowser(this.lastLoginUrl);

      const code = await waitForCode;
      const params = {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: config.clientId,
      };
      // Register the Touch ID key only when it will be used (HY_PRESENCE=off: no presence).
      if (config.presence && this.keys.hasPresence()) params.presence_jwk = JSON.stringify(this.keys.publicJwk('presence'));
      // Full fingerprint once; every later proof only carries its hash (dfp).
      params.device_fingerprint = JSON.stringify(deviceFingerprint());
      const res = await this.fetch(d.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: false,
      });
      if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
      this.saveTokens(await res.json());
      info('signed in', { user: this.tokens.user });
      await this.onAuthChange(true); // policy + tools/list_changed before the login result
      return this.tokens;
    } finally {
      server.close();
    }
  }

  // ---------- platform APIs used by the bridge ----------

  async getPolicy(etag) {
    const d = await this.discover();
    const res = await this.fetch(d.policy_endpoint, { headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`policy: HTTP ${res.status}`);
    return { policy: await res.json(), etag: res.headers.get('etag') };
  }

  async sendEvents(events) {
    const d = await this.discover();
    const body = JSON.stringify({ events });
    const res = await this.fetch(d.events_endpoint, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`events: HTTP ${res.status}`);
  }

  async getChallenge(id) {
    const d = await this.discover();
    const res = await this.fetch(`${d.challenges_endpoint}/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`challenge: HTTP ${res.status}`);
    return res.json();
  }
}

/** HTTPS only, except loopback (local mock / development). */
export function requireSecureUrl(url) {
  const u = new URL(url);
  const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopbackHost))
    throw new Error(`refusing insecure platform URL ${url}: use https:// (plain http is only allowed on localhost)`);
}

function loopback(expectedState) {
  return new Promise((resolve, reject) => {
    let settle;
    const waitForCode = new Promise((res, rej) => {
      settle = { res, rej };
      setTimeout(() => rej(new Error('login timed out')), LOGIN_TIMEOUT_MS).unref();
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      const ok = u.searchParams.get('state') === expectedState && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' });
      res.end(
        ok
          ? '<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font:16px system-ui;padding:24px">' +
              '<h2>Signed in ✓</h2><p id="m">Back to Claude Code. This tab closes automatically…</p>' +
              '<script>setTimeout(()=>{window.close();setTimeout(()=>{document.getElementById("m").textContent="You can close this tab."},300)},1000)</script>'
          : `<h2>Login failed: ${u.searchParams.get('error') ?? 'invalid state'}</h2>`,
      );
      ok ? settle.res(u.searchParams.get('code')) : settle.rej(new Error('login rejected'));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, waitForCode }));
  });
}

export function openBrowser(url) {
  const [cmd, ...args] = config.browserCmd.split(' ').filter(Boolean);
  try {
    spawn(cmd, [...args, url], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    warn('could not open browser', { error: e.message, url });
  }
}
