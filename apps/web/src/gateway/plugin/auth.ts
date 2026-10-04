import { type DeviceContext, device } from '@acl/db'
import {
  anthropicError,
  base64UrlDecode,
  type DeviceStatus,
  type GatewayTokenClaims,
  hmacSign,
  hmacVerify,
  keyStorage,
  type OsPostureKey,
  type PostureStatus,
  type RequestSignals,
  randomToken,
  signJwt,
  verifyJwt,
} from '@acl/shared'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { AppContext, AppEnv } from '../context.ts'
import { requireGatewayToken } from '../lib/auth.ts'
import { sha256B64Url, stableStringify } from './canonical.ts'
import { type DpopClaims, DpopError, nonceValid, verifyDpop, verifyPresence } from './dpop.ts'
import {
  claimJti,
  type DeviceRow,
  observeNetwork,
  publicUrl,
  type RequestNetwork,
  recordGatewayEvent,
  recordRejection,
  requestNetwork,
} from './store.ts'

export const ACCESS_TOKEN_TTL_SEC = 300

/** Access tokens of the plugin flow are the gateway's JWTs, bound to the device key by `cnf`. */
export type PluginTokenClaims = GatewayTokenClaims & {
  iss: string
  aud: string
  cnf: { jkt: string }
}

export async function issuePluginAccessToken(env: Env, dev: DeviceRow): Promise<string> {
  if (!dev.jkt) throw new Error('Device has no key')
  const iat = Math.floor(Date.now() / 1000)
  const claims: PluginTokenClaims = {
    iss: publicUrl(env),
    aud: publicUrl(env, '/mcp'),
    sub: dev.userId,
    org: dev.orgId,
    dev: dev.id,
    fph: dev.fingerprintHash,
    cnf: { jkt: dev.jkt },
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SEC,
  }
  return signJwt(env.JWT_SECRET, claims)
}

export type Posture = { status: PostureStatus; score: number | null; reason: string | null }

/** A request the plugin signed with its device key. */
export type PluginRequest = {
  claims: DpopClaims
  jkt: string
  device: DeviceRow
  /** A Touch ID proof over this exact request was valid. */
  presenceVerified: boolean
  network: RequestNetwork
  posture: Posture
}

const CONTEXT_FIELDS = ['os_version', 'kernel', 'hostname', 'os_user'] as const
const CONTEXT_STRINGS = [...CONTEXT_FIELDS, 'node', 'bridge', 'key_storage'] as const
const MAX_CONTEXT_BYTES = 4096

/** The known fields of a client context; anything else a client sends is not kept. */
function clientContext(input: unknown): DeviceContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('not an object')
  const raw = input as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : undefined)
  const ctx: DeviceContext = {}
  for (const key of CONTEXT_STRINGS) ctx[key] = text(raw[key])
  const client = raw.client as { name?: unknown; version?: unknown } | null | undefined
  if (client && typeof client === 'object')
    ctx.client = { name: text(client.name), version: text(client.version) }
  return ctx
}

/**
 * `HY-Client-Context` is bound to the proof by `ctxh`, the hash of the decoded header bytes. The
 * latest one is kept on the device, and a changed OS, host or Claude Code version is logged.
 */
async function checkClientContext(c: AppContext, dev: DeviceRow, claims: DpopClaims) {
  const header = c.req.header('hy-client-context')
  if (!header) {
    if (claims.ctxh) throw new DpopError('invalid_dpop_proof', 'client context missing')
    return
  }
  let bytes: Uint8Array<ArrayBuffer>
  let ctx: DeviceContext
  try {
    bytes = base64UrlDecode(header)
    if (bytes.length > MAX_CONTEXT_BYTES) throw new Error('too large')
    ctx = clientContext(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    throw new DpopError('invalid_dpop_proof', 'client context is malformed')
  }
  if ((await sha256B64Url(bytes)) !== claims.ctxh)
    throw new DpopError('invalid_dpop_proof', 'client context does not match proof')

  const prev = dev.context
  // A request without a Claude Code version keeps the last one known.
  const next = { ...ctx, client: ctx.client ?? prev?.client ?? null }
  if (prev && stableStringify(prev) === stableStringify(next)) return
  const fields: string[] = prev ? CONTEXT_FIELDS.filter((k) => prev[k] !== ctx[k]) : []
  if (prev?.client?.version && ctx.client?.version && prev.client.version !== ctx.client.version)
    fields.push('client.version')
  const db = c.get('db')
  c.executionCtx.waitUntil(
    Promise.all([
      db.update(device).set({ context: next }).where(eq(device.id, dev.id)),
      fields.length
        ? recordGatewayEvent(db, dev, 'client_context_changed', {
            fields,
            before: prev,
            after: next,
          })
        : null,
    ]),
  )
}

/**
 * EDR posture from the CrowdStrike ZTA token. The token is bound to the request by `ztah`, but
 * this gateway has neither CrowdStrike's signing key nor a Falcon cross-check, so a token it
 * cannot verify counts as unknown: never as healthy, and never by the score it claims.
 */
async function checkPosture(c: AppContext, claims: DpopClaims): Promise<Posture> {
  const token = c.req.header('hy-posture-zta')
  if (!token) {
    if (claims.ztah)
      throw new DpopError('invalid_dpop_proof', 'posture token missing but bound in proof')
    return { status: 'missing', score: null, reason: null }
  }
  if ((await sha256B64Url(token)) !== claims.ztah)
    throw new DpopError('invalid_dpop_proof', 'posture token does not match proof')
  return {
    status: 'unknown',
    score: null,
    reason: 'EDR posture token could not be verified by the gateway',
  }
}

const OS_POSTURE_KEYS: OsPostureKey[] = ['fv', 'sip', 'gk', 'fw']

function osPosture(claim: unknown): RequestSignals['osPosture'] | undefined {
  if (!claim || typeof claim !== 'object') return undefined
  const reported = claim as Record<string, unknown>
  const out: Partial<Record<OsPostureKey, boolean | null>> = {}
  for (const key of OS_POSTURE_KEYS) {
    const value = reported[key]
    if (typeof value === 'boolean' || value === null) out[key] = value
  }
  return out
}

/** What the request proved about the device and its session. Per-call signals are added later. */
export function deviceSignals(
  req: Pick<PluginRequest, 'claims' | 'device' | 'presenceVerified' | 'posture'>,
  network: { known: boolean; travelKmh: number | null },
  nowMs = Date.now(),
): RequestSignals {
  const { claims, device: dev, posture } = req
  const storage = keyStorage.safeParse(dev.keyStorage)
  return {
    keyStorage: storage.success ? storage.data : undefined,
    presenceCapable: Boolean(dev.presenceJkt),
    presenceVerified: req.presenceVerified,
    ipKnown: network.known,
    travelKmh: network.travelKmh,
    untrustedContentMinutesAgo: dev.untrustedAt
      ? Math.max(0, Math.floor((nowMs - dev.untrustedAt.getTime()) / 60_000))
      : null,
    untrustedSource: dev.untrustedSource,
    userIdleMinutes: typeof claims.idle === 'number' ? Math.floor(claims.idle / 60) : undefined,
    postureStatus: posture.status,
    postureScore: posture.score,
    postureReason: posture.reason,
    osPosture: osPosture(claims.osp),
  }
}

/**
 * Contract §3: authenticates a request by its key-bound access token and DPoP proof. Throws a
 * `DpopError`; with a valid token and the wrong key or machine it also records the theft.
 */
async function authenticate(c: AppContext, accessToken: string) {
  const db = c.get('db')
  const path = new URL(c.req.url).pathname
  const network = requestNetwork(c)
  const token = await verifyJwt<PluginTokenClaims>(c.env.JWT_SECRET, accessToken)
  if (!token || typeof token.cnf?.jkt !== 'string')
    throw new DpopError('invalid_token', 'unknown or expired token')

  const reject = async (err: DpopError, theft = false) => {
    if (err.code !== 'use_dpop_nonce')
      await recordRejection(db, {
        ip: network.ip,
        path,
        reason: err.message,
        victimDeviceId: token.dev,
        presentedJkt: err.presentedJkt,
        theft,
      })
    err.theft = theft
    return err
  }

  const method = c.req.method
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : new Uint8Array(await c.req.raw.clone().arrayBuffer())
  let proof: Awaited<ReturnType<typeof verifyDpop>>
  try {
    proof = await verifyDpop({
      proof: c.req.header('dpop'),
      method,
      url: publicUrl(c.env, path),
      accessToken,
      body,
      nonceValid: (nonce) => nonceValid(c.env.JWT_SECRET, nonce),
      claimJti: (jti, ttl) => claimJti(db, jti, ttl),
    })
  } catch (err) {
    if (err instanceof DpopError) throw await reject(err)
    throw err
  }
  const { claims, jkt } = proof
  const fail = (code: DpopError['code'], message: string, theft = false) => {
    const err = new DpopError(code, message)
    err.presentedJkt = jkt
    return reject(err, theft)
  }

  // A valid token with another key: someone holds the token without the key.
  if (jkt !== token.cnf.jkt)
    throw await fail('invalid_token', 'token is bound to a different key', true)
  const dev = await db.query.device.findFirst({ where: eq(device.id, token.dev) })
  if (!dev || dev.status === 'revoked' || dev.jkt !== jkt || dev.userId !== token.sub)
    throw await fail('invalid_token', 'device revoked')
  try {
    await checkClientContext(c, dev, claims)
  } catch (err) {
    if (err instanceof DpopError) throw await fail(err.code, err.message)
    throw err
  }
  // The same key from another machine: the key was copied.
  if (claims.dfp !== dev.fingerprintHash)
    throw await fail(
      'invalid_token',
      claims.dfp
        ? 'same key used from a different machine (device fingerprint changed)'
        : 'device fingerprint missing',
      true,
    )
  let posture: Posture
  try {
    posture = await checkPosture(c, claims)
  } catch (err) {
    if (err instanceof DpopError) throw await fail(err.code, err.message)
    throw err
  }
  const presenceVerified = await verifyPresence(
    c.req.header('hy-presence-proof'),
    claims,
    dev.presenceJkt,
  )
  if (!dev.lastSeenAt || Date.now() - dev.lastSeenAt.getTime() > 60_000)
    c.executionCtx.waitUntil(
      db.update(device).set({ lastSeenAt: new Date() }).where(eq(device.id, dev.id)),
    )
  const plugin: PluginRequest = { claims, jkt, device: dev, presenceVerified, network, posture }
  return { token, plugin }
}

function failure(c: AppContext, format: 'anthropic' | 'json', err: DpopError) {
  // The description travels in a quoted header value.
  const description = err.message.replace(/["\\\r\n]/g, ' ')
  c.header(
    'WWW-Authenticate',
    `DPoP error="${err.code}", error_description="${description}", algs="ES256"`,
  )
  return format === 'anthropic'
    ? c.json(anthropicError('authentication_error', `hy-guard: ${err.message}`), 401)
    : c.json({ error: err.code, error_description: err.message }, 401)
}

/**
 * Authenticates a device. The plugin sends `Authorization: DPoP <token>` with a proof signed by
 * its device key on every request; `bearer` also lets the older device-code tokens in.
 */
export const requireDevice = (
  format: 'anthropic' | 'json' = 'json',
  options: { bearer?: boolean } = {},
) => {
  const legacy = requireGatewayToken(format)
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.req.header('authorization') ?? ''
    if (!/^dpop /i.test(auth)) {
      if (options.bearer) return legacy(c, next)
      return failure(c, format, new DpopError('invalid_token', 'DPoP access token required'))
    }
    let result: Awaited<ReturnType<typeof authenticate>>
    try {
      result = await authenticate(c, auth.slice(5).trim())
    } catch (err) {
      if (err instanceof DpopError) return failure(c, format, err)
      throw err
    }
    const { token, plugin } = result
    const dev = plugin.device
    const deviceStatus: DeviceStatus = dev.status === 'pending' ? 'new' : 'trusted'
    const seen = await observeNetwork(c.get('db'), dev, plugin.network)
    c.set('plugin', plugin)
    c.set('principal', {
      userId: token.sub,
      orgId: dev.orgId,
      deviceId: dev.id,
      deviceStatus,
      signals: deviceSignals(plugin, seen),
    })
    await next()
  })
}

const MCP_SESSION_TTL_MS = 24 * 3600_000

/**
 * `Mcp-Session-Id` for the plugin: stateless, and bound to the device by an HMAC, so a session id
 * taken from one device is unknown (404) on any other.
 */
export async function issueMcpSession(env: Env, deviceId: string): Promise<string> {
  const head = `${Date.now().toString(36)}.${randomToken(12)}`
  return `${head}.${await hmacSign(env.JWT_SECRET, `hy-mcp-session:${deviceId}:${head}`)}`
}

export async function mcpSessionValid(
  env: Env,
  deviceId: string,
  sessionId: string | undefined,
): Promise<boolean> {
  const [issued, nonce, sig] = sessionId?.split('.') ?? []
  if (!issued || !nonce || !sig) return false
  const age = Date.now() - Number.parseInt(issued, 36)
  if (!(age >= 0 && age < MCP_SESSION_TTL_MS)) return false
  try {
    return await hmacVerify(env.JWT_SECRET, `hy-mcp-session:${deviceId}:${issued}.${nonce}`, sig)
  } catch {
    return false
  }
}
