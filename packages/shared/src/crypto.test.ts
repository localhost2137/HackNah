import { describe, expect, it } from 'vitest'
import { base64UrlEncode, decryptString, encryptString, signJwt, verifyJwt } from './crypto.ts'

const key = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))

describe('crypto', () => {
  it('round-trips AES-GCM and binds additional data', async () => {
    const ct = await encryptString(key, 'gho_secret', 'mcp:srv:user')
    expect(ct.startsWith('v1.')).toBe(true)
    expect(await decryptString(key, ct, 'mcp:srv:user')).toBe('gho_secret')
    await expect(decryptString(key, ct, 'mcp:srv:other')).rejects.toThrow()
  })

  it('signs and verifies JWTs, rejecting tampering and expiry', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt('s3cret', { sub: 'u1', exp: now + 60 })
    expect((await verifyJwt<{ sub: string; exp: number }>('s3cret', token))?.sub).toBe('u1')
    expect(await verifyJwt('other', token)).toBeNull()
    const [h, , s] = token.split('.')
    const forged = `${h}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: 'admin', exp: now + 60 })))}.${s}`
    expect(await verifyJwt('s3cret', forged)).toBeNull()
    expect(
      await verifyJwt('s3cret', await signJwt('s3cret', { sub: 'u1', exp: now - 1 })),
    ).toBeNull()
  })
})
