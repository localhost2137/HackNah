import { base64UrlDecode, base64UrlEncode } from '@acl/shared'

const encoder = new TextEncoder()

/**
 * Canonical JSON of the plugin protocol: object keys sorted by UTF-16 code unit, no whitespace,
 * `undefined` members dropped. Every hash in the protocol is taken over this form.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

/** Base64url (no padding) SHA-256 of a string (as UTF-8) or of raw bytes. */
export async function sha256B64Url(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

export type EcPublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }

/** A public EC P-256 key and nothing else: no private part, no extra members. */
export function publicJwk(input: unknown): EcPublicJwk | null {
  if (!input || typeof input !== 'object') return null
  const { kty, crv, x, y, d } = input as Record<string, unknown>
  if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') return null
  if (d !== undefined || !/^[\w-]{43}$/.test(x) || !/^[\w-]{43}$/.test(y)) return null
  return { kty, crv, x, y }
}

/** RFC 7638 thumbprint of an EC P-256 public key. */
export function jwkThumbprint(jwk: EcPublicJwk): Promise<string> {
  return sha256B64Url(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * The device code people compare between Claude Code and the browser: the first 60 bits of the
 * key thumbprint as base32, e.g. `PTQF-7KVA-3M2Q`. Display only, never an authenticator.
 */
export function shortCode(thumbprint: string): string {
  let bits = ''
  for (const b of base64UrlDecode(thumbprint).subarray(0, 8)) bits += b.toString(2).padStart(8, '0')
  const chars = Array.from(
    { length: 12 },
    (_, i) => BASE32[Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)],
  )
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`
}

/** Binds challenges and hook records to one action. The JSON-RPC id is not part of it. */
export function actionHash(tool: string, args: unknown): Promise<string> {
  return sha256B64Url(stableStringify({ tool, arguments: args ?? {} }))
}

/** What an admin pin holds: the hash of a tool's `{name, description, inputSchema}`. */
export function toolDefinitionHash(tool: {
  name: string
  description?: string
  inputSchema?: unknown
}): Promise<string> {
  return sha256B64Url(
    stableStringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
  )
}

/** PKCE S256: the challenge of a code verifier. */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256B64Url(verifier)
}
