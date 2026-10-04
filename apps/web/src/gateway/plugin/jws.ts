import { base64UrlDecode, base64UrlEncode } from '@acl/shared'
import { type EcPublicJwk, jwkThumbprint, publicJwk } from './canonical.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ES256 = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const

export class JwsError extends Error {}

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(base64UrlDecode(part)))
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {}
  throw new JwsError('malformed JWS')
}

export type VerifiedJws = {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  jwk: EcPublicJwk
  /** Thumbprint of the key that signed it. */
  jkt: string
}

/**
 * Verifies a compact JWS signed with the key in its own header (`jwk`), as DPoP and presence
 * proofs are. ES256 only; the signature is raw `r||s`, which is what WebCrypto takes.
 */
export async function verifySelfSignedJws(
  compact: string | null | undefined,
  expectedTyp: string,
): Promise<VerifiedJws> {
  const parts = compact?.split('.')
  if (parts?.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p)))
    throw new JwsError('malformed JWS')
  const [head, body, sig] = parts as [string, string, string]
  const header = decodeJson(head)
  const claims = decodeJson(body)
  if (header.typ !== expectedTyp) throw new JwsError(`typ must be ${expectedTyp}`)
  if (header.alg !== 'ES256') throw new JwsError('alg must be ES256')
  const jwk = publicJwk(header.jwk)
  if (!jwk) throw new JwsError('bad jwk')
  let ok = false
  try {
    const signature = base64UrlDecode(sig)
    const key = await crypto.subtle.importKey('jwk', jwk, ES256, false, ['verify'])
    ok =
      signature.length === 64 &&
      (await crypto.subtle.verify(SIGN, key, signature, encoder.encode(`${head}.${body}`)))
  } catch {
    ok = false
  }
  if (!ok) throw new JwsError('bad signature')
  return { header, claims, jwk, jkt: await jwkThumbprint(jwk) }
}

/** Signs a compact JWS with an ES256 private key. */
export async function signJws(
  key: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const b64 = (o: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(o)))
  const input = `${b64(header)}.${b64(payload)}`
  const sig = await crypto.subtle.sign(SIGN, key, encoder.encode(input))
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`
}

export function importEs256PrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ES256, false, ['sign'])
}
