import { base64UrlDecode } from '@acl/shared'
import { type EcPublicJwk, jwkThumbprint, publicJwk, sha256B64Url } from './canonical.ts'
import { importEs256PrivateKey, signJws } from './jws.ts'

export type ResponseSigner = {
  /** Published in discovery as `response_signing_jwk`; the plugin pins it on first contact. */
  jwk: EcPublicJwk & { alg: 'ES256'; use: 'sig'; kid: string }
  key: CryptoKey
}

const signers = new Map<string, Promise<ResponseSigner | null>>()

/** The secret is a private ES256 JWK, as JSON or as base64url of that JSON. */
function parseSecret(secret: string): JsonWebKey | null {
  const raw = secret.trim().replace(/^'(.*)'$/s, '$1')
  try {
    const json = raw.startsWith('{') ? raw : new TextDecoder().decode(base64UrlDecode(raw))
    return JSON.parse(json) as JsonWebKey
  } catch {
    return null
  }
}

async function loadSigner(secret: string): Promise<ResponseSigner | null> {
  const jwk = parseSecret(secret)
  const pub = publicJwk({ ...jwk, d: undefined })
  if (!jwk || !pub || typeof jwk.d !== 'string') {
    console.error('RESPONSE_SIGNING_JWK is not a private ES256 JWK')
    return null
  }
  const key = await importEs256PrivateKey({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: jwk.d })
  return { key, jwk: { ...pub, alg: 'ES256', use: 'sig', kid: await jwkThumbprint(pub) } }
}

/** The platform's response-signing key, or null when `RESPONSE_SIGNING_JWK` is not configured. */
export function responseSigner(env: { RESPONSE_SIGNING_JWK?: string }) {
  const secret = env.RESPONSE_SIGNING_JWK
  if (!secret) return Promise.resolve(null)
  let signer = signers.get(secret)
  if (!signer) {
    signer = loadSigner(secret).catch(() => null)
    signers.set(secret, signer)
  }
  return signer
}

/**
 * `HY-Response-Signature`: binds the status and body of a response to the proof id of the request
 * it answers, so nothing between the platform and the device can change or replay it.
 */
export async function signResponse(
  signer: ResponseSigner,
  jti: string | null,
  status: number,
  body: Uint8Array<ArrayBuffer>,
  nowMs = Date.now(),
): Promise<string> {
  return signJws(
    signer.key,
    { alg: 'ES256', kid: signer.jwk.kid, typ: 'hy-response+jwt' },
    { jti, status, bh: await sha256B64Url(body), iat: Math.floor(nowMs / 1000) },
  )
}
