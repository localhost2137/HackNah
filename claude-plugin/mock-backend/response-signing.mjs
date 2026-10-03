// Signed responses: the platform signs every response to a DPoP-signed request, so a
// man in the middle (rogue CA, TLS-inspection proxy) can't change tool results, policy or
// challenge status. Header:
//   HY-Response-Signature: <compact JWS, ES256>
//   payload { jti: the request's DPoP proof jti, status, bh: b64url(sha256(body)), iat }
// Binding to the request's jti stops replaying an old response to a new request.
// The public key is published in discovery (response_signing_jwk); the bridge pins it.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jwkThumbprint, sha256b64url } from './dpop.mjs';

const KEY_FILE = process.env.PLATFORM_SIGNING_KEY ?? join(dirname(fileURLToPath(import.meta.url)), '.data', 'platform-signing-key.pem');

function loadKey() {
  if (!existsSync(KEY_FILE)) {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(KEY_FILE));
}

const key = loadKey();
const { kty, crv, x, y } = createPublicKey(key).export({ format: 'jwk' });
export const signingJwk = { kty, crv, x, y, alg: 'ES256', use: 'sig', kid: jwkThumbprint({ kty, crv, x, y }) };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** The request's DPoP jti (parsed, not verified: it's only echoed back). */
export function requestJti(dpop) {
  try {
    return JSON.parse(Buffer.from(dpop.split('.')[1], 'base64url').toString('utf8')).jti ?? null;
  } catch {
    return null;
  }
}

export function signResponse(jti, status, body) {
  const input = `${b64({ alg: 'ES256', kid: signingJwk.kid, typ: 'hy-response+jwt' })}.${b64({
    jti,
    status,
    bh: sha256b64url(body),
    iat: Math.floor(Date.now() / 1000),
  })}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
