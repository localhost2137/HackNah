// Failure modes of DPoP verification (contract §3), with proofs signed by the plugin's test key.
import { base64UrlEncode } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import { sha256B64Url } from './canonical.ts'
import {
  currentNonce,
  type DpopRequest,
  nonceValid,
  requestJti,
  verifyDpop,
  verifyPresence,
} from './dpop.ts'
import { importEs256PrivateKey, signJws } from './jws.ts'
import { DEVICE_JKT, DEVICE_JWK, PLATFORM_JKT, PLATFORM_JWK } from './test-keys.ts'

const encoder = new TextEncoder()
const NOW = 1_800_000_000
const URL_ = 'https://gw.example.com/mcp'
const TOKEN = 'token-1'
const BODY = encoder.encode('{"jsonrpc":"2.0","id":7,"method":"tools/call"}')
const pub = ({ kty, crv, x, y }: typeof DEVICE_JWK) => ({ kty, crv, x, y })

async function proof(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  jwk: typeof DEVICE_JWK = DEVICE_JWK,
) {
  const base = {
    jti: 'jti-1',
    htm: 'POST',
    htu: URL_,
    iat: NOW,
    nonce: 'n-1',
    ath: await sha256B64Url(TOKEN),
    bh: await sha256B64Url(BODY),
  }
  return signJws(
    await importEs256PrivateKey(jwk),
    { typ: 'dpop+jwt', alg: 'ES256', jwk: pub(jwk), ...header },
    { ...base, ...claims },
  )
}

const request = (over: Partial<DpopRequest> & { proof: string }): DpopRequest => ({
  method: 'POST',
  url: URL_,
  accessToken: TOKEN,
  body: BODY,
  nowMs: NOW * 1000,
  nonceValid: (n) => n === 'n-1',
  claimJti: () => true,
  ...over,
})

const rejects = async (req: DpopRequest, code: string, message: string) =>
  expect(verifyDpop(req)).rejects.toMatchObject({ code, message })

describe('verifyDpop', () => {
  it('accepts a well-formed proof', async () => {
    const out = await verifyDpop(request({ proof: await proof() }))
    expect(out.jkt).toBe(DEVICE_JKT)
    expect(out.jwk).toEqual(pub(DEVICE_JWK))
  })

  it('requires the header', async () => {
    await rejects(request({ proof: '' }), 'invalid_dpop_proof', 'missing DPoP header')
  })

  it('rejects malformed tokens', async () => {
    for (const bad of ['abc', 'a.b', 'a.b.c.d', '!!.??.**', 'e30.e30.AAAA', 'W10.W10.AAAA'])
      await expect(verifyDpop(request({ proof: bad }))).rejects.toMatchObject({
        code: 'invalid_dpop_proof',
      })
  })

  it('rejects a wrong typ', async () => {
    await rejects(
      request({ proof: await proof({}, { typ: 'JWT' }) }),
      'invalid_dpop_proof',
      'typ must be dpop+jwt',
    )
  })

  it('rejects other algorithms, including none', async () => {
    for (const alg of ['none', 'HS256', 'ES384', 'RS256'])
      await rejects(
        request({ proof: await proof({}, { alg }) }),
        'invalid_dpop_proof',
        'alg must be ES256',
      )
  })

  it('rejects an unsigned token', async () => {
    const b64 = (o: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(o)))
    const unsigned = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk: pub(DEVICE_JWK) })}.${b64({ jti: 'x' })}.`
    await expect(verifyDpop(request({ proof: unsigned }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
    })
  })

  it('rejects a jwk with a private part or of another type', async () => {
    await rejects(
      request({ proof: await proof({}, { jwk: DEVICE_JWK }) }),
      'invalid_dpop_proof',
      'bad jwk',
    )
    await rejects(
      request({ proof: await proof({}, { jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } }) }),
      'invalid_dpop_proof',
      'bad jwk',
    )
    await rejects(
      request({ proof: await proof({}, { jwk: undefined }) }),
      'invalid_dpop_proof',
      'bad jwk',
    )
  })

  it('rejects a proof signed by a key other than the one in its header', async () => {
    await rejects(
      request({ proof: await proof({}, { jwk: pub(PLATFORM_JWK) }) }),
      'invalid_dpop_proof',
      'bad signature',
    )
  })

  it('rejects a DER-encoded signature', async () => {
    const [head, body] = (await proof()).split('.')
    const der = base64UrlEncode(new Uint8Array(70).fill(1))
    await rejects(
      request({ proof: `${head}.${body}.${der}` }),
      'invalid_dpop_proof',
      'bad signature',
    )
  })

  it('rejects another method or URL', async () => {
    const p = await proof()
    await rejects(request({ proof: p, method: 'GET' }), 'invalid_dpop_proof', 'htm mismatch')
    await rejects(
      request({ proof: p, url: 'https://gw.example.com/llm/v1/messages' }),
      'invalid_dpop_proof',
      'htu mismatch',
    )
    await rejects(
      request({ proof: p, url: 'https://internal:8787/mcp' }),
      'invalid_dpop_proof',
      'htu mismatch',
    )
  })

  it('rejects a proof whose htu carries a query', async () => {
    await rejects(
      request({ proof: await proof({ htu: `${URL_}?a=1` }), url: `${URL_}?a=1` }),
      'invalid_dpop_proof',
      'htu mismatch',
    )
  })

  it('rejects iat outside ±60 s, or missing', async () => {
    const window = 'iat outside allowed window'
    await rejects(request({ proof: await proof({ iat: NOW - 61 }) }), 'invalid_dpop_proof', window)
    await rejects(request({ proof: await proof({ iat: NOW + 61 }) }), 'invalid_dpop_proof', window)
    await rejects(request({ proof: await proof({ iat: `${NOW}` }) }), 'invalid_dpop_proof', window)
    await rejects(request({ proof: await proof({ iat: undefined }) }), 'invalid_dpop_proof', window)
    await expect(
      verifyDpop(request({ proof: await proof({ iat: NOW - 60 }) })),
    ).resolves.toBeTruthy()
    await expect(
      verifyDpop(request({ proof: await proof({ iat: NOW + 60 }) })),
    ).resolves.toBeTruthy()
  })

  it('asks for a nonce when it is missing or stale', async () => {
    const ask = 'fresh nonce required'
    await rejects(request({ proof: await proof({ nonce: undefined }) }), 'use_dpop_nonce', ask)
    await rejects(request({ proof: await proof({ nonce: 'old' }) }), 'use_dpop_nonce', ask)
  })

  it('rejects a missing or oversized jti', async () => {
    await rejects(
      request({ proof: await proof({ jti: undefined }) }),
      'invalid_dpop_proof',
      'jti missing',
    )
    await rejects(request({ proof: await proof({ jti: '' }) }), 'invalid_dpop_proof', 'jti missing')
    await rejects(
      request({ proof: await proof({ jti: 'x'.repeat(129) }) }),
      'invalid_dpop_proof',
      'jti missing',
    )
  })

  it('rejects a replayed jti, scoped to the key', async () => {
    const seen = new Set<string>()
    const claimJti = (jti: string, ttl: number) => {
      expect(ttl).toBe(300)
      return !seen.has(jti) && Boolean(seen.add(jti))
    }
    const p = await proof()
    await verifyDpop(request({ proof: p, claimJti }))
    await rejects(request({ proof: p, claimJti }), 'invalid_dpop_proof', 'jti replayed')
    // The same jti from another key is another proof.
    const other = await proof({}, {}, PLATFORM_JWK)
    await expect(verifyDpop(request({ proof: other, claimJti }))).resolves.toMatchObject({
      jkt: PLATFORM_JKT,
    })
  })

  it('does not burn the jti of a proof that fails another check', async () => {
    let claimed = 0
    const claimJti = () => {
      claimed++
      return true
    }
    const p = await proof()
    await expect(
      verifyDpop(request({ proof: p, claimJti, accessToken: 'other' })),
    ).rejects.toThrow()
    await expect(
      verifyDpop(request({ proof: p, claimJti, body: encoder.encode('x') })),
    ).rejects.toThrow()
    await expect(
      verifyDpop(request({ proof: p, claimJti, nonceValid: () => false })),
    ).rejects.toThrow()
    expect(claimed).toBe(0)
  })

  it('requires ath when the request carries a token', async () => {
    await rejects(
      request({ proof: await proof({ ath: undefined }) }),
      'invalid_dpop_proof',
      'ath mismatch',
    )
    await rejects(
      request({ proof: await proof(), accessToken: 'token-2' }),
      'invalid_dpop_proof',
      'ath mismatch',
    )
  })

  it('does not need ath at the token endpoint', async () => {
    const p = await proof({ ath: undefined })
    await expect(verifyDpop(request({ proof: p, accessToken: undefined }))).resolves.toBeTruthy()
  })

  it('requires bh when the request has a body', async () => {
    const mismatch = 'body hash mismatch'
    await rejects(
      request({ proof: await proof({ bh: undefined }) }),
      'invalid_dpop_proof',
      mismatch,
    )
    await rejects(
      request({ proof: await proof(), body: encoder.encode('{"other":true}') }),
      'invalid_dpop_proof',
      mismatch,
    )
    const noBody = await proof({ bh: undefined })
    await expect(verifyDpop(request({ proof: noBody, body: undefined }))).resolves.toBeTruthy()
    await expect(
      verifyDpop(request({ proof: noBody, body: new Uint8Array() })),
    ).resolves.toBeTruthy()
  })

  it('reports the presented key on failures after the signature check', async () => {
    await expect(
      verifyDpop(request({ proof: await proof(), method: 'GET' })),
    ).rejects.toMatchObject({ presentedJkt: DEVICE_JKT })
  })
})

describe('verifyPresence', () => {
  it('needs the registered key and the same claims', async () => {
    const claims = {
      jti: 'jti-1',
      htm: 'POST',
      htu: URL_,
      iat: NOW,
      nonce: 'n-1',
      ath: 'a',
      bh: 'b',
    }
    const key = await importEs256PrivateKey(PLATFORM_JWK)
    const header = { typ: 'hy-presence+jwt', alg: 'ES256', jwk: pub(PLATFORM_JWK) }
    const presence = await signJws(key, header, claims)
    expect(await verifyPresence(presence, claims, PLATFORM_JKT)).toBe(true)
    expect(await verifyPresence(presence, claims, DEVICE_JKT)).toBe(false)
    expect(await verifyPresence(presence, { ...claims, bh: 'c' }, PLATFORM_JKT)).toBe(false)
    const asDpop = await signJws(key, { ...header, typ: 'dpop+jwt' }, claims)
    expect(await verifyPresence(asDpop, claims, PLATFORM_JKT)).toBe(false)
    expect(await verifyPresence('garbage', claims, PLATFORM_JKT)).toBe(false)
  })
})

describe('nonces', () => {
  const secret = 'server-secret'

  it('accepts the current and the previous minute only', async () => {
    const t = 1_800_000_000_000
    const nonce = await currentNonce(secret, t)
    expect(await nonceValid(secret, nonce, t)).toBe(true)
    expect(await nonceValid(secret, nonce, t + 60_000)).toBe(true)
    expect(await nonceValid(secret, nonce, t + 120_000)).toBe(false)
    expect(await nonceValid(secret, nonce, t - 60_000)).toBe(false)
  })

  it('rotates every minute and depends on the secret', async () => {
    const t = 1_800_000_000_000
    expect(await currentNonce(secret, t)).not.toBe(await currentNonce(secret, t + 60_000))
    expect(await nonceValid('other-secret', await currentNonce(secret, t), t)).toBe(false)
  })

  it('rejects anything that is not an issued nonce', async () => {
    for (const bad of [undefined, null, '', 'nonce', 42, {}])
      expect(await nonceValid(secret, bad)).toBe(false)
  })
})

describe('requestJti', () => {
  it('reads the jti without verifying', async () => {
    expect(requestJti(await proof({ jti: 'abc' }))).toBe('abc')
    expect(requestJti('garbage')).toBeNull()
    expect(requestJti('a.e30.c')).toBeNull()
  })
})
