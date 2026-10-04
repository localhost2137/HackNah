// Every vector of claude-plugin/docs/TEST_VECTORS.md, byte for byte.
import { base64UrlDecode, base64UrlEncode } from '@acl/shared'
import { describe, expect, it } from 'vitest'
import {
  actionHash,
  jwkThumbprint,
  pkceChallenge,
  publicJwk,
  sha256B64Url,
  shortCode,
  stableStringify,
  toolDefinitionHash,
} from './canonical.ts'
import { verifyDpop, verifyPresence } from './dpop.ts'
import { importEs256PrivateKey, verifySelfSignedJws } from './jws.ts'
import { responseSigner, signResponse } from './response-signing.ts'
import { DEVICE_JKT, DEVICE_JWK, PLATFORM_JKT, PLATFORM_JWK } from './test-keys.ts'

const ACCESS_TOKEN = 'example-access-token-123'
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
const PROOF_IAT = 1791040000
const PROOF =
  'eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoiWnJnWG5Eb05oVGRwUGdocDJJbDZ6RFhuRDAzbVlmMEI1RktyQ2VGVF9IUSIsInkiOiJ5YUt4QklKVnpHdkFOclZlcjQxNXNtOE5UOEhVSWIwZlJSRDZGcW9CaXpFIn19.eyJqdGkiOiJ2ZWN0b3ItanRpLTAwMDEiLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9wbGF0Zm9ybS5leGFtcGxlLmNvbS9tY3AiLCJpYXQiOjE3OTEwNDAwMDAsIm5vbmNlIjoibm9uY2UtYWJjIiwiYXRoIjoiT2VIS093ZG1SNFNsZmFJOHVQOHlPTm51VkptZ1lEQkY5cm1OVW5FSl9FRSIsImJoIjoiRjdEa19vaVkwUGUyYU4wVU45TUhnbWJvMFhDOFNRNjdzQkxpdTd6WHVSTSIsImRmcCI6InpQeDQ1bWpPUE1OTUJJMW1oLTgzRVdEeEZhVTdZR1J3RzhuT1E2VjRwU2ciLCJjdHhoIjoiNWhnekZER0F4X1FnZ0RWX29CSm9sS0EwYm9vdDVfcWVGYlpCNmloVDgtYyIsImlkbGUiOjQsIm9zcCI6eyJmdiI6dHJ1ZSwic2lwIjp0cnVlLCJnayI6dHJ1ZSwiZnciOmZhbHNlfSwiaG9vayI6eyJzaWQiOiJjbGF1ZGUtc2Vzc2lvbi00MiIsImVpZCI6Imhvb2stMSIsImFoIjoiVFVQQXRVcFJaZjVGWXVlalhSTnhuT0FIdTBfc2tmQWhTRml5LURfQlc0ZyIsInRzIjoxNzkxMDM5OTk5fX0.Yd7WRqw3DF2ZYngV_h85ET_GKXnZrWpXaGzW5xi-H0l6pgo9JNOnpxKFeLZtc8lrGl1QQevGIUV1N5YW-fDA3w'
const PRESENCE_PROOF =
  'eyJ0eXAiOiJoeS1wcmVzZW5jZStqd3QiLCJhbGciOiJFUzI1NiIsImp3ayI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6InJHcEhKZ0w1MzlNV2VTYVdKbk9naERxT01SMVF2WmRGeXBtRWI2dTlVTlkiLCJ5IjoiQ2tVYW5WaUVjNHU2anBsUTRkcS1DMkRyZEp2eDc2dTB5a3FFVm1CS0k1NCJ9fQ.eyJqdGkiOiJ2ZWN0b3ItanRpLTAwMDEiLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9wbGF0Zm9ybS5leGFtcGxlLmNvbS9tY3AiLCJpYXQiOjE3OTEwNDAwMDAsIm5vbmNlIjoibm9uY2UtYWJjIiwiYXRoIjoiT2VIS093ZG1SNFNsZmFJOHVQOHlPTm51VkptZ1lEQkY5cm1OVW5FSl9FRSIsImJoIjoiRjdEa19vaVkwUGUyYU4wVU45TUhnbWJvMFhDOFNRNjdzQkxpdTd6WHVSTSIsImRmcCI6InpQeDQ1bWpPUE1OTUJJMW1oLTgzRVdEeEZhVTdZR1J3RzhuT1E2VjRwU2ciLCJjdHhoIjoiNWhnekZER0F4X1FnZ0RWX29CSm9sS0EwYm9vdDVfcWVGYlpCNmloVDgtYyIsImlkbGUiOjQsIm9zcCI6eyJmdiI6dHJ1ZSwic2lwIjp0cnVlLCJnayI6dHJ1ZSwiZnciOmZhbHNlfSwiaG9vayI6eyJzaWQiOiJjbGF1ZGUtc2Vzc2lvbi00MiIsImVpZCI6Imhvb2stMSIsImFoIjoiVFVQQXRVcFJaZjVGWXVlalhSTnhuT0FIdTBfc2tmQWhTRml5LURfQlc0ZyIsInRzIjoxNzkxMDM5OTk5fX0.fVQsCR83qyYao8-TITeEkTUoAf5cbMMLcaSN9_xoBwuC2UwWbKX4Oc9U2Ir9uIDDBFVoKJJsO3nHkE-Di8n5vg'
const RESPONSE_BODY = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
const RESPONSE_SIGNATURE =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6IkJQelg2X08yeXB3MjgzQ1ppRGJqMDJpYVlJSmhFdjlpVlRfM0Y5RjAxNTQiLCJ0eXAiOiJoeS1yZXNwb25zZStqd3QifQ.eyJqdGkiOiJ2ZWN0b3ItanRpLTAwMDEiLCJzdGF0dXMiOjIwMCwiYmgiOiJSbmRMc2k0WEQyeU5YYmE4ci1Wd2JSRmg0QzI5UGg2NGJvalM0SF9lYUdRIiwiaWF0IjoxNzkxMDQwMDAxfQ.YjY3n41BNuuCFNQ29KtOXplkCIgLan54vHUq5nbWJLdmnEHT9GzqLCBwtmxsGARt9Yx5DQI0BRs3IDfv5Y5log'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('§1 canonical JSON', () => {
  it('sorts keys, drops whitespace and keeps non-ASCII', () => {
    expect(stableStringify({ b: 2, a: { d: [3, { z: 1, y: 'Kraków' }], c: null }, e: 'x' })).toBe(
      '{"a":{"c":null,"d":[3,{"y":"Kraków","z":1}]},"b":2,"e":"x"}',
    )
  })

  it('drops undefined members', () => {
    expect(stableStringify({ b: undefined, a: 1 })).toBe('{"a":1}')
  })
})

describe('§2 thumbprint and device code', () => {
  it('derives the RFC 7638 thumbprint', async () => {
    expect(await jwkThumbprint(publicJwk({ ...DEVICE_JWK, d: undefined })!)).toBe(DEVICE_JKT)
  })

  it('derives the device code from the first 60 bits', () => {
    expect(shortCode(DEVICE_JKT)).toBe('EB3F-BRAA-6TNE')
  })

  it('refuses a JWK with a private part', () => {
    expect(publicJwk(DEVICE_JWK)).toBeNull()
  })
})

describe('§3 hashes', () => {
  const action = 'TUPAtUpRZf5FYuejXRNxnOAHu0_skfAhSFiy-D_BW4g'

  it('action hash', async () => {
    expect(
      await actionHash('email_send', { body: 'Hello', subject: 'Hi', to: 'anna@company.com' }),
    ).toBe(action)
  })

  it('action hash does not depend on key order', async () => {
    expect(
      await actionHash('email_send', { subject: 'Hi', body: 'Hello', to: 'anna@company.com' }),
    ).toBe(action)
  })

  it('tool definition hash', async () => {
    expect(
      await toolDefinitionHash({
        name: 'crm_search_customers',
        description: 'Search customers in the CRM by name or city.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }),
    ).toBe('9hck5VItJvTcD0EKD5ZtZu4QE3AYAorWH1kUTTH6_y0')
  })

  it('device fingerprint hash', async () => {
    const fingerprint = {
      machine_id_hash: 'xRi8UR5PNZym6zhjGl-1f_9DkdQwbXvrJ_JFg05qssc',
      hardware_model: 'Mac16,8',
      cpu_model: 'Apple M4 Pro',
      cpu_count: 14,
      memory_gb: 24,
      os_family: 'darwin',
      arch: 'arm64',
    }
    expect(await sha256B64Url(stableStringify(fingerprint))).toBe(
      'zPx45mjOPMNMBI1mh-83EWDxFaU7YGRwG8nOQ6V4pSg',
    )
  })

  it('ath', async () => {
    expect(await sha256B64Url(ACCESS_TOKEN)).toBe('OeHKOwdmR4SlfaI8uP8yONnuVJmgYDBF9rmNUnEJ_EE')
  })

  it('bh of the raw body bytes', async () => {
    expect(await sha256B64Url(encoder.encode(BODY))).toBe(
      'F7Dk_oiY0Pe2aN0UN9MHgmbo0XC8SQ67sBLiu7zXuRM',
    )
  })

  it('bh of an empty body', async () => {
    expect(await sha256B64Url(new Uint8Array())).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  })
})

describe('§4 client context', () => {
  const header =
    'eyJicmlkZ2UiOiIwLjEuMCIsImNsaWVudCI6eyJuYW1lIjoiY2xhdWRlLWNvZGUiLCJ2ZXJzaW9uIjoiMi4xLjI4OCJ9LCJob3N0bmFtZSI6Ik1hYy5sb2NhbCIsImtlcm5lbCI6IjI1LjYuMCIsImtleV9zdG9yYWdlIjoic2VjdXJlX2VuY2xhdmUiLCJub2RlIjoiMjYuNS4wIiwib3NfdXNlciI6ImRldiIsIm9zX3ZlcnNpb24iOiJtYWNPUyAyNi42LjIifQ'

  it('ctxh is the hash of the decoded header bytes', async () => {
    const decoded = base64UrlDecode(header)
    expect(decoder.decode(decoded)).toBe(
      '{"bridge":"0.1.0","client":{"name":"claude-code","version":"2.1.288"},"hostname":"Mac.local","kernel":"25.6.0","key_storage":"secure_enclave","node":"26.5.0","os_user":"dev","os_version":"macOS 26.6.2"}',
    )
    expect(await sha256B64Url(decoded)).toBe('5hgzFDGAx_QggDV_oBJolKA0boot5_qeFbZB6ihT8-c')
  })
})

describe('§5 DPoP proof', () => {
  /** The vector's request, with the time and state dependent checks satisfied. */
  const request = (over: Partial<Parameters<typeof verifyDpop>[0]> = {}) => ({
    proof: PROOF,
    method: 'POST',
    url: 'https://platform.example.com/mcp',
    accessToken: ACCESS_TOKEN,
    body: encoder.encode(BODY),
    nowMs: PROOF_IAT * 1000,
    nonceValid: (nonce: unknown) => nonce === 'nonce-abc',
    claimJti: () => true,
    ...over,
  })

  it('accepts the proof and derives the thumbprint', async () => {
    const { jkt, claims } = await verifyDpop(request())
    expect(jkt).toBe(DEVICE_JKT)
    expect(claims.jti).toBe('vector-jti-0001')
    expect(claims.hook).toEqual({
      sid: 'claude-session-42',
      eid: 'hook-1',
      ah: 'TUPAtUpRZf5FYuejXRNxnOAHu0_skfAhSFiy-D_BW4g',
      ts: 1791039999,
    })
  })

  it('ignores the query of the request URL', async () => {
    await expect(
      verifyDpop(request({ url: 'https://platform.example.com/mcp?x=1' })),
    ).resolves.toBeTruthy()
  })

  it('rejects a changed body', async () => {
    await expect(verifyDpop(request({ body: encoder.encode(`${BODY} `) }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
      message: 'body hash mismatch',
    })
  })

  it('rejects another URL', async () => {
    await expect(
      verifyDpop(request({ url: 'https://platform.example.com/v1/policy' })),
    ).rejects.toMatchObject({ code: 'invalid_dpop_proof', message: 'htu mismatch' })
    await expect(
      verifyDpop(request({ url: 'http://platform.example.com/mcp' })),
    ).rejects.toMatchObject({ message: 'htu mismatch' })
  })

  it('rejects another method', async () => {
    await expect(verifyDpop(request({ method: 'GET' }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
      message: 'htm mismatch',
    })
  })

  it('rejects another access token', async () => {
    await expect(verifyDpop(request({ accessToken: 'another-token' }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
      message: 'ath mismatch',
    })
  })

  it('rejects a replay within 5 minutes', async () => {
    const seen = new Set<string>()
    const claimJti = (jti: string) => !seen.has(jti) && Boolean(seen.add(jti))
    await verifyDpop(request({ claimJti }))
    await expect(verifyDpop(request({ claimJti }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
      message: 'jti replayed',
    })
  })

  it('rejects a changed signature', async () => {
    const flipped = PROOF.slice(0, -1) + (PROOF.endsWith('w') ? 'A' : 'w')
    await expect(verifyDpop(request({ proof: flipped }))).rejects.toMatchObject({
      code: 'invalid_dpop_proof',
      message: 'bad signature',
    })
    const [head, body, sig] = PROOF.split('.') as [string, string, string]
    const other = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`
    await expect(verifyDpop(request({ proof: `${head}.${body}.${other}` }))).rejects.toMatchObject({
      message: 'bad signature',
    })
  })

  it('accepts the presence proof only for the registered presence key', async () => {
    const { claims } = await verifyDpop(request())
    expect(await verifyPresence(PRESENCE_PROOF, claims, PLATFORM_JKT)).toBe(true)
    expect(await verifyPresence(PRESENCE_PROOF, claims, DEVICE_JKT)).toBe(false)
    expect(await verifyPresence(PRESENCE_PROOF, claims, null)).toBe(false)
    expect(await verifyPresence(null, claims, PLATFORM_JKT)).toBe(false)
  })

  it('rejects a presence proof made for another request', async () => {
    const { claims } = await verifyDpop(request())
    for (const key of ['jti', 'htm', 'htu', 'iat', 'ath', 'bh', 'nonce'])
      expect(await verifyPresence(PRESENCE_PROOF, { ...claims, [key]: 'x' }, PLATFORM_JKT)).toBe(
        false,
      )
  })

  it('does not accept the DPoP proof as a presence proof', async () => {
    const { claims } = await verifyDpop(request())
    expect(await verifyPresence(PROOF, claims, DEVICE_JKT)).toBe(false)
  })
})

describe('§6 response signature', () => {
  const claimsOf = (jws: string) =>
    JSON.parse(decoder.decode(base64UrlDecode(jws.split('.')[1]!))) as Record<string, unknown>

  /** Verifies a response signature the way the plugin does, against the pinned key. */
  async function verifies(jws: string, jwk = PLATFORM_JWK): Promise<boolean> {
    const [head, body, sig] = jws.split('.') as [string, string, string]
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlDecode(sig),
      encoder.encode(`${head}.${body}`),
    )
  }

  it('the vector verifies with the published key and covers the body', async () => {
    expect(await verifies(RESPONSE_SIGNATURE)).toBe(true)
    expect(claimsOf(RESPONSE_SIGNATURE)).toEqual({
      jti: 'vector-jti-0001',
      status: 200,
      bh: await sha256B64Url(RESPONSE_BODY),
      iat: 1791040001,
    })
  })

  it('signs the same header and claims as the vector', async () => {
    const signer = (await responseSigner({ RESPONSE_SIGNING_JWK: JSON.stringify(PLATFORM_JWK) }))!
    expect(signer.jwk).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: PLATFORM_JWK.x,
      y: PLATFORM_JWK.y,
      alg: 'ES256',
      use: 'sig',
      kid: PLATFORM_JKT,
    })
    const jws = await signResponse(
      signer,
      'vector-jti-0001',
      200,
      encoder.encode(RESPONSE_BODY),
      1791040001_000,
    )
    // ES256 signatures are randomised: the signed part is identical, the signature only valid.
    expect(jws.split('.').slice(0, 2)).toEqual(RESPONSE_SIGNATURE.split('.').slice(0, 2))
    expect(base64UrlDecode(jws.split('.')[2]!)).toHaveLength(64)
    expect(await verifies(jws)).toBe(true)
    expect(await verifies(jws, { ...PLATFORM_JWK, x: DEVICE_JWK.x, y: DEVICE_JWK.y })).toBe(false)
  })

  it('accepts the key as base64url of the JWK and is absent without one', async () => {
    const encoded = base64UrlEncode(encoder.encode(JSON.stringify(PLATFORM_JWK)))
    expect((await responseSigner({ RESPONSE_SIGNING_JWK: encoded }))?.jwk.kid).toBe(PLATFORM_JKT)
    expect(await responseSigner({})).toBeNull()
    expect(await responseSigner({ RESPONSE_SIGNING_JWK: '{"kty":"EC"}' })).toBeNull()
  })

  it('a self-signed JWS is not a response signature', async () => {
    await expect(verifySelfSignedJws(RESPONSE_SIGNATURE, 'hy-response+jwt')).rejects.toThrow(
      'bad jwk',
    )
    await expect(importEs256PrivateKey(DEVICE_JWK)).resolves.toBeTruthy()
  })
})

describe('§7 PKCE', () => {
  it('S256 challenge of the RFC 7636 verifier', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})
