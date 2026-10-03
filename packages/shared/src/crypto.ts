const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data))
  return base64UrlEncode(new Uint8Array(sig))
}

export async function hmacVerify(
  secret: string,
  data: string,
  signature: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64UrlDecode(signature),
    encoder.encode(data),
  )
}

export type GatewayTokenClaims = {
  /** User id. */
  sub: string
  org: string
  /** Device id the token is bound to. */
  dev: string
  /** SHA-256 of the device fingerprint presented at login. */
  fph: string
  iat: number
  exp: number
}

export async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = base64UrlEncode(encoder.encode(JSON.stringify(claims)))
  return `${header}.${body}.${await hmacSign(secret, `${header}.${body}`)}`
}

export async function verifyJwt<T extends { exp: number }>(
  secret: string,
  token: string,
): Promise<T | null> {
  const [header, body, sig] = token.split('.')
  if (!header || !body || !sig) return null
  if (!(await hmacVerify(secret, `${header}.${body}`, sig))) return null
  try {
    const claims = JSON.parse(decoder.decode(base64UrlDecode(body))) as T
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

async function aesKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(base64Key)
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64url encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** AES-256-GCM. Output format: `v1.<iv>.<ciphertext>`, both base64url. */
export async function encryptString(
  base64Key: string,
  plaintext: string,
  aad = '',
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    await aesKey(base64Key),
    encoder.encode(plaintext),
  )
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`
}

export async function decryptString(base64Key: string, payload: string, aad = ''): Promise<string> {
  const [version, iv, ct] = payload.split('.')
  if (version !== 'v1' || !iv || !ct) throw new Error('Unsupported ciphertext format')
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(iv), additionalData: encoder.encode(aad) },
    await aesKey(base64Key),
    base64UrlDecode(ct),
  )
  return decoder.decode(pt)
}
