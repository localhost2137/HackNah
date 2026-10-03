// Reference DPoP verifier (RFC 9449 + body hash + presence proof).
// The real backend must implement the same checks; see docs/BACKEND_CONTRACT.md §3.

import { createHash, createPublicKey, verify } from 'node:crypto';

const MAX_SKEW_S = 60;
const JTI_TTL_MS = 5 * 60_000;
const NONCE_ROTATE_MS = 60_000;

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
export const sha256b64url = (data) => createHash('sha256').update(data).digest('base64url');

export function jwkThumbprint(jwk) {
  return sha256b64url(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`);
}

export class DpopError extends Error {
  constructor(error, description) {
    super(description);
    this.error = error; // invalid_dpop_proof | use_dpop_nonce | invalid_token
  }
}

// ---- server nonces: current + previous are accepted ----
let nonces = [crypto.randomUUID(), crypto.randomUUID()];
setInterval(() => (nonces = [crypto.randomUUID(), nonces[0]]), NONCE_ROTATE_MS).unref();
export const currentNonce = () => nonces[0];

// ---- replay cache ----
const seenJti = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of seenJti) if (exp < now) seenJti.delete(k);
}, 30_000).unref();

export function verifyJws(compact, expectedTyp) {
  const parts = compact?.split('.');
  if (parts?.length !== 3) throw new DpopError('invalid_dpop_proof', 'malformed JWS');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (header.typ !== expectedTyp) throw new DpopError('invalid_dpop_proof', `typ must be ${expectedTyp}`);
  if (header.alg !== 'ES256') throw new DpopError('invalid_dpop_proof', 'alg must be ES256');
  const { kty, crv, x, y, d } = header.jwk ?? {};
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y || d) throw new DpopError('invalid_dpop_proof', 'bad jwk');
  const key = createPublicKey({ key: { kty, crv, x, y }, format: 'jwk' });
  const ok = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new DpopError('invalid_dpop_proof', 'bad signature');
  return { header, claims, jkt: jwkThumbprint(header.jwk), jwk: { kty, crv, x, y } };
}

/**
 * Verify the DPoP header of a request.
 * @param {object} o
 * @param {string} o.proof        DPoP header value
 * @param {string} o.method       request method
 * @param {string} o.url          public URL of the endpoint (scheme+host+path)
 * @param {string} [o.accessToken] when present, `ath` must match
 * @param {Buffer} [o.body]       when non-empty, `bh` must match
 * @param {boolean} [o.requireNonce=true]
 */
export function verifyDpop({ proof, method, url, accessToken, body, requireNonce = true }) {
  if (!proof) throw new DpopError('invalid_dpop_proof', 'missing DPoP header');
  const { claims, jkt, jwk } = verifyJws(proof, 'dpop+jwt');
  const now = Math.floor(Date.now() / 1000);
  if (claims.htm !== method) throw new DpopError('invalid_dpop_proof', 'htm mismatch');
  const u = new URL(url);
  if (claims.htu !== `${u.origin}${u.pathname}`) throw new DpopError('invalid_dpop_proof', 'htu mismatch');
  if (typeof claims.iat !== 'number' || Math.abs(now - claims.iat) > MAX_SKEW_S)
    throw new DpopError('invalid_dpop_proof', 'iat outside allowed window');
  if (requireNonce && !nonces.includes(claims.nonce))
    throw new DpopError('use_dpop_nonce', 'fresh nonce required');
  if (!claims.jti || seenJti.has(claims.jti)) throw new DpopError('invalid_dpop_proof', 'jti replayed');
  if (accessToken !== undefined && claims.ath !== sha256b64url(accessToken))
    throw new DpopError('invalid_dpop_proof', 'ath mismatch');
  if (body?.length && claims.bh !== sha256b64url(body)) throw new DpopError('invalid_dpop_proof', 'body hash mismatch');
  seenJti.set(claims.jti, Date.now() + JTI_TTL_MS);
  return { claims, jkt, jwk };
}

/** Presence proof: same claims as the DPoP proof, signed by the registered presence key. */
export function verifyPresence(proof, dpopClaims, expectedJkt) {
  if (!proof || !expectedJkt) return false;
  try {
    const { claims, jkt } = verifyJws(proof, 'hy-presence+jwt');
    if (jkt !== expectedJkt) return false;
    return ['jti', 'htm', 'htu', 'iat', 'ath', 'bh', 'nonce'].every((k) => claims[k] === dpopClaims[k]);
  } catch {
    return false;
  }
}
