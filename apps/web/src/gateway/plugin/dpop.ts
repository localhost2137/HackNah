import { hmacSign, timingSafeEqual } from '@acl/shared'
import { type EcPublicJwk, sha256B64Url } from './canonical.ts'
import { JwsError, verifySelfSignedJws } from './jws.ts'

export const MAX_SKEW_SEC = 60
export const JTI_TTL_SEC = 300
const NONCE_ROTATE_MS = 60_000

export type DpopErrorCode = 'invalid_dpop_proof' | 'use_dpop_nonce' | 'invalid_token'

export class DpopError extends Error {
  /** Thumbprint of the key the request was signed with, when the proof itself was valid. */
  presentedJkt?: string
  /** A valid credential used with the wrong key or from another machine. */
  theft = false

  constructor(
    readonly code: DpopErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Server nonces need no storage: a nonce is an HMAC of the minute it was issued in, so every
 * isolate derives the same one, and the current and the previous minute are accepted.
 */
function nonceAt(secret: string, minute: number): Promise<string> {
  return hmacSign(secret, `hy-dpop-nonce:${minute}`)
}

export function currentNonce(secret: string, nowMs = Date.now()): Promise<string> {
  return nonceAt(secret, Math.floor(nowMs / NONCE_ROTATE_MS))
}

export async function nonceValid(secret: string, nonce: unknown, nowMs = Date.now()) {
  if (typeof nonce !== 'string' || !nonce) return false
  const minute = Math.floor(nowMs / NONCE_ROTATE_MS)
  const accepted = await Promise.all([nonceAt(secret, minute), nonceAt(secret, minute - 1)])
  return accepted.some((n) => timingSafeEqual(n, nonce))
}

export type DpopClaims = Record<string, unknown> & {
  jti: string
  htm: string
  htu: string
  iat: number
}

export type VerifiedProof = { claims: DpopClaims; jkt: string; jwk: EcPublicJwk }

export type DpopRequest = {
  /** The `DPoP` header. */
  proof: string | null | undefined
  method: string
  /** Public URL of the endpoint. Only scheme, host and path are compared. */
  url: string
  /** When given, the proof's `ath` must be the hash of this token. */
  accessToken?: string
  /** Raw request body. When not empty, the proof's `bh` must be its hash. */
  body?: Uint8Array<ArrayBuffer>
  nowMs?: number
  /** Whether `nonce` is one the server issued recently. */
  nonceValid: (nonce: unknown) => boolean | Promise<boolean>
  /** Stores the proof id for `ttlSec`; false when it was already there (a replay). */
  claimJti: (jti: string, ttlSec: number) => boolean | Promise<boolean>
}

/**
 * Verifies a DPoP proof (RFC 9449) with this platform's extension: `bh`, the hash of the request
 * body. The checks run in the order of contract §3; the proof id is only stored once everything
 * else holds, so a request that failed for another reason can be repeated.
 */
export async function verifyDpop(req: DpopRequest): Promise<VerifiedProof> {
  if (!req.proof) throw new DpopError('invalid_dpop_proof', 'missing DPoP header')
  let jws: Awaited<ReturnType<typeof verifySelfSignedJws>>
  try {
    jws = await verifySelfSignedJws(req.proof, 'dpop+jwt')
  } catch (err) {
    throw new DpopError(
      'invalid_dpop_proof',
      err instanceof JwsError ? err.message : 'malformed JWS',
    )
  }
  const { claims, jkt, jwk } = jws
  const fail = (code: DpopErrorCode, message: string) => {
    const e = new DpopError(code, message)
    e.presentedJkt = jkt
    return e
  }
  if (claims.htm !== req.method.toUpperCase()) throw fail('invalid_dpop_proof', 'htm mismatch')
  const u = new URL(req.url)
  if (claims.htu !== `${u.origin}${u.pathname}`) throw fail('invalid_dpop_proof', 'htu mismatch')
  const now = Math.floor((req.nowMs ?? Date.now()) / 1000)
  if (typeof claims.iat !== 'number' || Math.abs(now - claims.iat) > MAX_SKEW_SEC)
    throw fail('invalid_dpop_proof', 'iat outside allowed window')
  if (!(await req.nonceValid(claims.nonce))) throw fail('use_dpop_nonce', 'fresh nonce required')
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 128)
    throw fail('invalid_dpop_proof', 'jti missing')
  if (req.accessToken !== undefined && claims.ath !== (await sha256B64Url(req.accessToken)))
    throw fail('invalid_dpop_proof', 'ath mismatch')
  if (req.body?.length && claims.bh !== (await sha256B64Url(req.body)))
    throw fail('invalid_dpop_proof', 'body hash mismatch')
  if (!(await req.claimJti(`${jkt}:${claims.jti}`, JTI_TTL_SEC)))
    throw fail('invalid_dpop_proof', 'jti replayed')
  return { claims: claims as DpopClaims, jkt, jwk }
}

const PRESENCE_BOUND = ['jti', 'htm', 'htu', 'iat', 'ath', 'bh', 'nonce'] as const

/**
 * A presence proof is a second signature over the same claims as the DPoP proof, by the device's
 * registered Touch ID key. Valid means a person confirmed this exact request.
 */
export async function verifyPresence(
  proof: string | null | undefined,
  dpopClaims: Record<string, unknown>,
  registeredJkt: string | null | undefined,
): Promise<boolean> {
  if (!proof || !registeredJkt) return false
  try {
    const { claims, jkt } = await verifySelfSignedJws(proof, 'hy-presence+jwt')
    if (jkt !== registeredJkt) return false
    return PRESENCE_BOUND.every((k) => claims[k] === dpopClaims[k])
  } catch {
    return false
  }
}

/** The proof id of a request, unverified: it is only echoed into the response signature. */
export function requestJti(proof: string): string | null {
  try {
    const body = proof.split('.')[1] ?? ''
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/')
    const jti = (JSON.parse(atob(b64)) as { jti?: unknown }).jti
    return typeof jti === 'string' ? jti : null
  } catch {
    return null
  }
}
