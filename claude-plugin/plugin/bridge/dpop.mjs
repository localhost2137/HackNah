// DPoP proofs (RFC 9449) plus the extensions this platform uses:
//   bh   - base64url SHA-256 of the HTTP body (standard DPoP does not cover the body,
//          and for MCP the body is the action)
//   dfp  - hash of the stable device fingerprint (fingerprint.mjs)
//   ctxh - hash of the HY-Client-Context header (OS, kernel, Claude Code version, ...)
//   idle - seconds since the last keyboard/mouse input (macOS)
//   hook - Claude Code PreToolUse record for this exact tool call {sid, eid, ah, ts}
//   ztah - hash of the CrowdStrike ZTA token sent in HY-Posture-ZTA (device posture)
//   osp  - built-in OS posture {fv, sip, gk, fw} (FileVault, SIP, Gatekeeper, firewall)
//   HY-Presence-Proof - a second JWS over the same claims, signed with the presence key

import { b64url, randomId, sha256b64url } from './util.mjs';

async function jws(keys, keyName, header, claims, body) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await keys.sign(keyName, Buffer.from(input), body);
  return `${input}.${sig}`;
}

/**
 * @param {object} o
 * @param {string} o.method   HTTP method
 * @param {string} o.url      full request URL (query/fragment are stripped for htu)
 * @param {string} [o.accessToken]  adds `ath`
 * @param {string|Buffer} [o.body]  adds `bh`
 * @param {string} [o.nonce]  server-provided DPoP-Nonce
 * @param {object} [o.extra]  platform claims: dfp (device fingerprint hash), ctxh (client context hash)
 */
export async function createProof(keys, { method, url, accessToken, body, nonce, extra }) {
  const u = new URL(url);
  const claims = {
    jti: randomId(),
    htm: method.toUpperCase(),
    htu: `${u.origin}${u.pathname}`,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) claims.nonce = nonce;
  if (accessToken) claims.ath = sha256b64url(accessToken);
  if (body !== undefined) claims.bh = sha256b64url(body);
  Object.assign(claims, extra);

  const proof = await jws(keys, 'routine', { typ: 'dpop+jwt', alg: 'ES256', jwk: keys.publicJwk('routine') }, claims);
  return { proof, claims };
}

/**
 * Presence proof: same claims, presence key. On macOS this triggers Touch ID; the signer
 * writes the prompt from `body` (which must match the `bh` claim), not from our text.
 */
export function createPresenceProof(keys, claims, body) {
  return jws(keys, 'presence', { typ: 'hy-presence+jwt', alg: 'ES256', jwk: keys.publicJwk('presence') }, claims, body);
}
