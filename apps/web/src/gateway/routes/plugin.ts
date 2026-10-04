import {
  chunkRows,
  type Db,
  device,
  member,
  pluginAuthCode,
  pluginChallenge,
  pluginEvent,
  pluginRefreshToken,
  user,
} from '@acl/db'
import { hmacSign, randomId, randomToken, sha256Hex, timingSafeEqual } from '@acl/shared'
import { and, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { audit } from '../../server/audit.ts'
import { createAuth } from '../../server/auth.ts'
import { getInstanceId } from '../../server/instance.ts'
import type { AppContext, AppEnv } from '../context.ts'
import { invalidateDeviceStatus } from '../lib/auth.ts'
import { loadActiveGuardrails } from '../lib/guardrail.ts'
import { ACCESS_TOKEN_TTL_SEC, issuePluginAccessToken, requireDevice } from '../plugin/auth.ts'
import {
  jwkThumbprint,
  pkceChallenge,
  publicJwk,
  sha256B64Url,
  shortCode,
  stableStringify,
} from '../plugin/canonical.ts'
import { DpopError, nonceValid, verifyDpop, verifyPresence } from '../plugin/dpop.ts'
import { authorizePage, type ChallengeViewer, challengePage, messagePage } from '../plugin/pages.ts'
import { buildPolicy } from '../plugin/policy.ts'
import { responseSigner } from '../plugin/response-signing.ts'
import {
  claimJti,
  type DeviceRow,
  publicUrl,
  recordGatewayEvent,
  recordRejection,
  requestNetwork,
  revokeRefreshTokens,
  touchNetwork,
} from '../plugin/store.ts'
import { markUntrusted, pluginToolLevels } from '../plugin/tool-call.ts'
import { listedTools } from './mcp.ts'

const CLIENT_ID = 'hy-cc-plugin'
const AUTH_CODE_TTL_SEC = 60
const REFRESH_TOKEN_TTL_SEC = 12 * 3600
/** After a sign-in, refreshes are silent for this long; then a person has to be there again. */
const UNLOCK_TTL_SEC = 8 * 3600
const MAX_EVENTS = 100
const B64URL_SHA256 = /^[\w-]{43}$/

// ---------------------------------------------------------------------------
// The dashboard's own sign-in, reused for the two browser pages
// ---------------------------------------------------------------------------

async function viewer(c: AppContext) {
  const db = c.get('db')
  const session = await createAuth(db).api.getSession({ headers: c.req.raw.headers })
  if (!session) return null
  const orgId = await getInstanceId(db)
  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)),
    columns: { role: true },
  })
  return { user: session.user, session: session.session, orgId, role: membership?.role ?? null }
}

/** Ties a form to the session it was rendered for and to what it decides. */
function csrfToken(env: Env, sessionId: string, purpose: string): Promise<string> {
  return hmacSign(env.JWT_SECRET, `hy-csrf:${sessionId}:${purpose}`)
}

/** Browsers send `Origin` on every form post and fetch; another site's page fails here. */
function sameOrigin(c: AppContext): boolean {
  return c.req.header('origin') === new URL(c.env.PUBLIC_URL).origin
}

const wantsJson = (c: AppContext) => (c.req.header('accept') ?? '').includes('application/json')

const loginRedirect = (c: AppContext) => {
  const url = new URL(c.req.url)
  return c.redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`)
}

// ---------------------------------------------------------------------------
// Sign-in: OAuth 2.0 code + PKCE, loopback redirect, key binding through dpop_jkt
// ---------------------------------------------------------------------------

const authorizeParams = z.object({
  response_type: z.literal('code'),
  client_id: z.literal(CLIENT_ID),
  // RFC 8252: only a loopback address, on any port.
  redirect_uri: z.string().refine((value) => {
    try {
      const u = new URL(value)
      return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]')
    } catch {
      return false
    }
  }),
  state: z.string().min(1).max(512),
  code_challenge: z.string().regex(B64URL_SHA256),
  code_challenge_method: z.literal('S256'),
  dpop_jkt: z.string().regex(B64URL_SHA256),
  device_name: z.string().max(120).default('unknown device'),
  key_storage: z.string().max(40).default('unknown'),
  platform: z.string().max(40).default('unknown'),
})
type AuthorizeParams = z.infer<typeof authorizeParams>

function backToPlugin(params: AuthorizeParams, result: Record<string, string>): string {
  const url = new URL(params.redirect_uri)
  url.search = new URLSearchParams({ ...result, state: params.state }).toString()
  return url.toString()
}

type OAuthError = { error: string; error_description?: string }
const oauthError = (error: string, description?: string): OAuthError => ({
  error,
  ...(description ? { error_description: description } : {}),
})

/**
 * Creates or updates the device a sign-in registers, keyed by the thumbprint of its key. The
 * first device of a user is trusted (they just signed in); a further one starts as `pending`
 * and its first request goes to the approvals queue, as with the device-code login.
 */
async function registerDevice(
  c: AppContext,
  code: typeof pluginAuthCode.$inferSelect,
  proof: { jkt: string; jwk: Record<string, string>; dfp: string },
  extra: {
    presenceJwk: Record<string, string> | null
    fingerprint: Record<string, string | number> | null
  },
): Promise<DeviceRow | OAuthError> {
  const db = c.get('db')
  const net = requestNetwork(c)
  const presenceJkt = extra.presenceJwk ? await jwkThumbprint(publicJwk(extra.presenceJwk)!) : null
  const registration = {
    jkt: proof.jkt,
    jwk: proof.jwk,
    presenceJkt,
    presenceJwk: extra.presenceJwk,
    keyStorage: code.keyStorage,
    shortCode: shortCode(proof.jkt),
    label: code.deviceName,
    platform: code.platform,
    lastSeenAt: new Date(),
  }

  const byKey = await db.query.device.findFirst({ where: eq(device.jkt, proof.jkt) })
  if (byKey) {
    if (byKey.status === 'revoked') return oauthError('invalid_grant', 'device revoked')
    // A key registered to one machine can't be re-registered from another: that is a copied
    // key, even if whoever holds it also has valid sign-in credentials.
    if (byKey.fingerprintHash !== proof.dfp) {
      await recordRejection(db, {
        ip: net.ip,
        path: '/token',
        reason: 'sign-in with a key registered to a different machine',
        victimDeviceId: byKey.id,
        presentedJkt: proof.jkt,
        theft: true,
      })
      return oauthError('invalid_grant', 'this device key is registered to a different machine')
    }
    // Another account signing in on the same device takes it over; the old sessions end.
    if (byKey.userId !== code.userId) await revokeRefreshTokens(db, byKey.id)
    const [row] = await db
      .update(device)
      .set({
        ...registration,
        userId: code.userId,
        orgId: code.orgId,
        fingerprintDetails: extra.fingerprint ?? byKey.fingerprintDetails,
      })
      .where(eq(device.id, byKey.id))
      .returning()
    return row!
  }

  // The same machine with a new key (the plugin's key was reset): the device stays, the key
  // changes, and everything issued to the old key ends.
  const sameMachine = await db.query.device.findFirst({
    where: and(eq(device.userId, code.userId), eq(device.fingerprintHash, proof.dfp)),
  })
  if (sameMachine) {
    if (sameMachine.status === 'revoked') return oauthError('invalid_grant', 'device revoked')
    await revokeRefreshTokens(db, sameMachine.id)
    const [row] = await db
      .update(device)
      .set({ ...registration, fingerprintDetails: extra.fingerprint })
      .where(eq(device.id, sameMachine.id))
      .returning()
    return row!
  }

  const trusted = await db.query.device.findFirst({
    where: and(
      eq(device.userId, code.userId),
      eq(device.orgId, code.orgId),
      eq(device.status, 'trusted'),
    ),
    columns: { id: true },
  })
  const [row] = await db
    .insert(device)
    .values({
      id: randomId('dev'),
      orgId: code.orgId,
      userId: code.userId,
      fingerprintHash: proof.dfp,
      fingerprintDetails: extra.fingerprint,
      status: trusted ? 'pending' : 'trusted',
      firstSeenIp: net.ip,
      firstSeenCountry: net.country,
      ...registration,
    })
    .returning()
  return row!
}

async function tokenResponse(
  c: AppContext,
  dev: DeviceRow,
  refresh: { token: string; unlockedUntil: Date },
) {
  const owner = await c.get('db').query.user.findFirst({
    where: eq(user.id, dev.userId),
    columns: { id: true, email: true, name: true },
  })
  return c.json({
    access_token: await issuePluginAccessToken(c.env, dev),
    token_type: 'DPoP',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    unlock_expires_in: Math.max(
      0,
      Math.floor((refresh.unlockedUntil.getTime() - Date.now()) / 1000),
    ),
    refresh_token: refresh.token,
    user: { id: dev.userId, email: owner?.email ?? null, name: owner?.name ?? null },
    device: { id: dev.id, short_code: dev.shortCode, key_storage: dev.keyStorage },
  })
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function authorizationCodeGrant(
  c: AppContext,
  form: Record<string, string>,
  proof: Awaited<ReturnType<typeof verifyDpop>>,
) {
  const db = c.get('db')
  // Single use: the code is gone whether or not the rest of the exchange succeeds.
  const [code] = form.code
    ? await db
        .delete(pluginAuthCode)
        .where(eq(pluginAuthCode.codeHash, await sha256Hex(form.code)))
        .returning()
    : []
  if (!code || code.expiresAt.getTime() < Date.now())
    return c.json(oauthError('invalid_grant', 'bad code'), 400)
  if (code.clientId !== form.client_id || code.redirectUri !== form.redirect_uri)
    return c.json(oauthError('invalid_grant', 'client/redirect mismatch'), 400)
  if ((await pkceChallenge(form.code_verifier ?? '')) !== code.codeChallenge)
    return c.json(oauthError('invalid_grant', 'PKCE failed'), 400)
  if (proof.jkt !== code.dpopJkt)
    return c.json(oauthError('invalid_dpop_proof', 'key differs from dpop_jkt'), 400)

  let presenceJwk: Record<string, string> | null = null
  if (form.presence_jwk) {
    presenceJwk = publicJwk(parseJsonObject(form.presence_jwk))
    if (!presenceJwk)
      return c.json(oauthError('invalid_request', 'presence_jwk must be a public P-256 key'), 400)
  }
  // The full fingerprint comes once; every later proof only carries its hash (`dfp`).
  const dfp = proof.claims.dfp
  if (typeof dfp !== 'string' || !B64URL_SHA256.test(dfp))
    return c.json(oauthError('invalid_request', 'device fingerprint missing from proof'), 400)
  const reported = parseJsonObject(form.device_fingerprint)
  if (form.device_fingerprint && !reported)
    return c.json(oauthError('invalid_request', 'device_fingerprint is malformed'), 400)
  if (reported && (await sha256B64Url(stableStringify(reported))) !== dfp)
    return c.json(oauthError('invalid_request', 'device_fingerprint does not match proof'), 400)
  const fingerprint = reported
    ? Object.fromEntries(
        Object.entries(reported).filter(
          (entry): entry is [string, string | number] =>
            typeof entry[1] === 'string' || typeof entry[1] === 'number',
        ),
      )
    : null

  const dev = await registerDevice(
    c,
    code,
    { jkt: proof.jkt, jwk: proof.jwk, dfp },
    { presenceJwk, fingerprint },
  )
  if ('error' in dev) return c.json(dev, 400)
  invalidateDeviceStatus(dev.id)
  // The network the user approved the device from is a known one.
  await touchNetwork(db, dev.id, requestNetwork(c))
  await audit(db, {
    orgId: dev.orgId,
    actorId: dev.userId,
    action: 'device.login',
    target: dev.id,
    data: { label: dev.label, keyStorage: dev.keyStorage, shortCode: dev.shortCode },
  })

  // A sign-in is a person, so it starts an unlock window.
  const token = randomToken(32)
  const unlockedUntil = new Date(Date.now() + UNLOCK_TTL_SEC * 1000)
  await db.insert(pluginRefreshToken).values({
    id: randomId('prt'),
    tokenHash: await sha256Hex(token),
    orgId: dev.orgId,
    userId: dev.userId,
    deviceId: dev.id,
    jkt: proof.jkt,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    unlockedUntil,
  })
  return tokenResponse(c, dev, { token, unlockedUntil })
}

async function refreshTokenGrant(
  c: AppContext,
  form: Record<string, string>,
  proof: Awaited<ReturnType<typeof verifyDpop>>,
) {
  const db = c.get('db')
  const net = requestNetwork(c)
  const row = form.refresh_token
    ? await db.query.pluginRefreshToken.findFirst({
        where: eq(pluginRefreshToken.tokenHash, await sha256Hex(form.refresh_token)),
      })
    : undefined
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now())
    return c.json(oauthError('invalid_grant', 'bad refresh token'), 400)
  const stolen = (reason: string) =>
    recordRejection(db, {
      ip: net.ip,
      path: '/token',
      reason,
      victimDeviceId: row.deviceId,
      presentedJkt: proof.jkt,
      theft: true,
    })
  // A valid refresh token with another key: someone holds the token without the key.
  if (row.jkt !== proof.jkt) {
    await stolen('refresh token bound to another key')
    return c.json(oauthError('invalid_grant', 'refresh token bound to another key'), 400)
  }
  const dev = await db.query.device.findFirst({ where: eq(device.id, row.deviceId) })
  if (!dev || dev.status === 'revoked' || dev.jkt !== row.jkt || dev.userId !== row.userId)
    return c.json(oauthError('invalid_grant', 'device revoked'), 400)
  if (proof.claims.dfp !== dev.fingerprintHash) {
    await stolen('refresh from a different machine (device fingerprint changed)')
    return c.json(oauthError('invalid_grant', 'device fingerprint changed'), 400)
  }

  // Inside the unlock window a refresh is silent. After it, only a person can extend the
  // session: a Touch ID proof over this same request, or a new sign-in.
  let unlockedUntil = row.unlockedUntil
  if (unlockedUntil.getTime() < Date.now()) {
    const present = await verifyPresence(
      c.req.header('hy-presence-proof'),
      proof.claims,
      dev.presenceJkt,
    )
    if (!present)
      return c.json(
        oauthError(
          'invalid_grant',
          dev.presenceJkt ? 'unlock_required' : 'session expired, sign in again',
        ),
        400,
      )
    unlockedUntil = new Date(Date.now() + UNLOCK_TTL_SEC * 1000)
    await db
      .update(pluginRefreshToken)
      .set({ unlockedUntil })
      .where(eq(pluginRefreshToken.id, row.id))
    await recordGatewayEvent(db, dev, 'session_unlocked', { method: 'touch_id' })
  }
  return tokenResponse(c, dev, { token: form.refresh_token!, unlockedUntil })
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

type ChallengeRow = typeof pluginChallenge.$inferSelect

const challengeStatus = (row: ChallengeRow) =>
  row.status === 'pending' && row.expiresAt.getTime() < Date.now() ? 'expired' : row.status

function findChallenge(db: Db, id: string) {
  return db.query.pluginChallenge.findFirst({ where: eq(pluginChallenge.id, id) })
}

/**
 * Who is looking at the approval page. A session only counts as a fresh sign-in when it started
 * after the challenge was issued: a remembered dashboard session must not approve.
 */
async function challengeViewer(c: AppContext, row: ChallengeRow): Promise<ChallengeViewer> {
  const me = await viewer(c)
  if (!me) return { state: 'anonymous' }
  const email = me.user.email
  if (me.user.id !== row.userId) return { state: 'other', email }
  if (new Date(me.session.createdAt).getTime() < row.createdAt.getTime())
    return { state: 'stale', email }
  return {
    state: 'owner',
    email,
    csrf: await csrfToken(c.env, me.session.id, `challenge:${row.id}`),
  }
}

async function decideChallenge(c: AppContext, decision: 'approve' | 'deny') {
  const db = c.get('db')
  const row = await findChallenge(db, c.req.param('id') ?? '')
  if (!row) return c.html(messagePage('Unknown challenge', 'This approval link is not valid.'), 404)
  const refuse = async (message: string) =>
    wantsJson(c)
      ? c.json({ error: message }, 403)
      : c.html(
          challengePage(
            { ...row, status: challengeStatus(row) },
            await challengeViewer(c, row),
            message,
          ),
          403,
        )
  if (!sameOrigin(c)) return refuse('This request did not come from the approval page.')

  let approvedBy = row.approvedBy
  if (challengeStatus(row) === 'pending') {
    if (decision === 'approve') {
      const who = await challengeViewer(c, row)
      if (who.state === 'anonymous') return refuse('Sign in to approve.')
      if (who.state === 'other')
        return refuse(
          `Signed in as ${who.email}, but this device belongs to another account. Not approved.`,
        )
      if (who.state === 'stale')
        return refuse('Approving needs a fresh sign-in. Sign in again, then approve.')
      const form = await c.req.parseBody()
      if (typeof form.csrf !== 'string' || !timingSafeEqual(form.csrf, who.csrf))
        return refuse('This form has expired. Reload the page and try again.')
      approvedBy = who.email
    }
    // Decided once: a challenge that was denied or expired in the meantime stays that way.
    await db
      .update(pluginChallenge)
      .set(
        decision === 'approve'
          ? { status: 'approved', approvedBy, approvedAt: new Date() }
          : { status: 'denied' },
      )
      .where(
        and(
          eq(pluginChallenge.id, row.id),
          eq(pluginChallenge.status, 'pending'),
          gt(pluginChallenge.expiresAt, new Date()),
        ),
      )
  }
  const after = (await findChallenge(db, row.id)) ?? row
  if (wantsJson(c)) return c.json({ status: challengeStatus(after), approved_by: after.approvedBy })
  return c.redirect(`/challenge/${row.id}`)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * The server side of the hy-guard plugin protocol (claude-plugin/docs/BACKEND_CONTRACT.md), next
 * to the MCP gateway (`/mcp`) and the LLM gateway (`/llm`), which live in their own routes.
 */
export const plugin = new Hono<AppEnv>()
  .get('/.well-known/hy-platform', async (c) => {
    const signer = await responseSigner(c.env)
    return c.json({
      issuer: publicUrl(c.env),
      authorization_endpoint: publicUrl(c.env, '/authorize'),
      token_endpoint: publicUrl(c.env, '/token'),
      gateway_url: publicUrl(c.env, '/mcp'),
      policy_endpoint: publicUrl(c.env, '/v1/policy'),
      events_endpoint: publicUrl(c.env, '/v1/events'),
      challenges_endpoint: publicUrl(c.env, '/v1/challenges'),
      llm_gateway_url: publicUrl(c.env, '/llm'),
      ...(signer ? { response_signing_jwk: signer.jwk } : {}),
      // This gateway inspects and rewrites model traffic (guardrails, redaction, model routing),
      // so Claude Code has to run auto mode's safety checks as its own requests.
      llm_auto_mode_server: false,
      dpop_signing_alg_values_supported: ['ES256'],
    })
  })

  .get('/authorize', async (c) => {
    const params = authorizeParams.safeParse(c.req.query())
    if (!params.success) {
      const fields = [...new Set(params.error.issues.map((i) => i.path.join('.')))].join(', ')
      return c.html(messagePage('Bad request', `Missing or invalid: ${fields}`), 400)
    }
    const me = await viewer(c)
    if (!me) return loginRedirect(c)
    if (!me.role)
      return c.html(
        messagePage('No access', `${me.user.email} is not a member of this organization.`),
        403,
      )
    const csrf = await csrfToken(c.env, me.session.id, `authorize:${stableStringify(params.data)}`)
    return c.html(
      authorizePage({
        email: me.user.email,
        deviceName: params.data.device_name,
        platform: params.data.platform,
        keyStorage: params.data.key_storage,
        shortCode: shortCode(params.data.dpop_jkt),
        fields: { ...params.data, csrf },
      }),
    )
  })
  .post('/authorize/decision', async (c) => {
    const form = await c.req.parseBody()
    const params = authorizeParams.safeParse(form)
    const me = await viewer(c)
    const fail = (status: 400 | 403, message: string) =>
      wantsJson(c)
        ? c.json({ error: message }, status)
        : c.html(messagePage('Sign-in not approved', message), status)
    if (!params.success) return fail(400, 'The sign-in request is malformed. Start again.')
    if (!me?.role) return fail(403, 'Sign in to the dashboard first, then start again.')
    const csrf = await csrfToken(c.env, me.session.id, `authorize:${stableStringify(params.data)}`)
    if (!sameOrigin(c) || typeof form.csrf !== 'string' || !timingSafeEqual(form.csrf, csrf))
      return fail(403, 'This form has expired. Start the sign-in again from Claude Code.')

    let target: string
    if (form.decision !== 'approve') {
      target = backToPlugin(params.data, { error: 'access_denied' })
    } else {
      const code = randomToken(32)
      await c
        .get('db')
        .insert(pluginAuthCode)
        .values({
          codeHash: await sha256Hex(code),
          clientId: params.data.client_id,
          redirectUri: params.data.redirect_uri,
          codeChallenge: params.data.code_challenge,
          dpopJkt: params.data.dpop_jkt,
          orgId: me.orgId,
          userId: me.user.id,
          deviceName: params.data.device_name,
          platform: params.data.platform,
          keyStorage: params.data.key_storage,
          expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000),
        })
      target = backToPlugin(params.data, { code })
    }
    return wantsJson(c) ? c.json({ redirect: target }) : c.redirect(target)
  })

  .post('/token', async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer())
    const form = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(body)))
    const db = c.get('db')
    let proof: Awaited<ReturnType<typeof verifyDpop>>
    try {
      // No `ath`: there is no token yet. The body is covered by `bh`.
      proof = await verifyDpop({
        proof: c.req.header('dpop'),
        method: 'POST',
        url: publicUrl(c.env, '/token'),
        body,
        nonceValid: (nonce) => nonceValid(c.env.JWT_SECRET, nonce),
        claimJti: (jti, ttl) => claimJti(db, jti, ttl),
      })
    } catch (err) {
      // An authorization server answers a bad proof, a missing nonce included, with 400.
      if (err instanceof DpopError) return c.json(oauthError(err.code, err.message), 400)
      throw err
    }
    if (form.client_id !== CLIENT_ID) return c.json(oauthError('invalid_client'), 400)
    if (form.grant_type === 'authorization_code') return authorizationCodeGrant(c, form, proof)
    if (form.grant_type === 'refresh_token') return refreshTokenGrant(c, form, proof)
    return c.json(oauthError('unsupported_grant_type'), 400)
  })

  .get('/v1/policy', requireDevice(), async (c) => {
    const tools = await listedTools(c, { id: null, state: null })
    const [levels, guardrails] = await Promise.all([
      pluginToolLevels(c, tools),
      loadActiveGuardrails(c.get('db'), c.get('principal').orgId),
    ])
    const { policy, etag } = await buildPolicy(guardrails, tools, levels, sha256B64Url)
    c.header('ETag', etag)
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    return c.json(policy)
  })

  .post('/v1/events', requireDevice(), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null
    if (!Array.isArray(body?.events)) return c.json({ error: 'events must be an array' }, 400)
    const dev = c.get('plugin')!.device
    const now = Date.now()
    const rows: (typeof pluginEvent.$inferInsert)[] = []
    let untrusted: { at: number; source: string } | null = null
    for (const raw of body.events.slice(0, MAX_EVENTS)) {
      const e = raw as {
        event_id?: unknown
        type?: unknown
        ts?: unknown
        source?: unknown
        context?: unknown
        data?: { tool?: unknown; untrusted_content?: unknown; input?: { domain?: unknown } }
      }
      if (typeof e?.event_id !== 'string' || !e.event_id || e.event_id.length > 100) continue
      if (typeof e.type !== 'string' || e.type.length > 100) continue
      // A device cannot date its events into the future.
      const parsed = typeof e.ts === 'string' ? Date.parse(e.ts) : Number.NaN
      const ts = Number.isFinite(parsed) ? Math.min(parsed, now) : now
      rows.push({
        eventId: e.event_id,
        orgId: dev.orgId,
        deviceId: dev.id,
        userId: dev.userId,
        type: e.type,
        source: typeof e.source === 'string' ? e.source.slice(0, 40) : null,
        ts: new Date(ts),
        context: e.context ?? null,
        data: e.data ?? null,
      })
      // Claude Code read outside content with one of its own tools (WebFetch, WebSearch).
      if (
        e.type === 'pre_tool_use' &&
        e.data?.untrusted_content === true &&
        ts >= (untrusted?.at ?? 0)
      )
        untrusted = {
          at: ts,
          source: [e.data.input?.domain, e.data.tool ? `(${String(e.data.tool)})` : null]
            .filter((part) => typeof part === 'string' && part)
            .join(' '),
        }
    }
    // At-least-once delivery: an event that is already there is skipped.
    for (const chunk of chunkRows(rows, 10))
      await c.get('db').insert(pluginEvent).values(chunk).onConflictDoNothing()
    if (untrusted && untrusted.at > (dev.untrustedAt?.getTime() ?? 0))
      await markUntrusted(c, dev.id, new Date(untrusted.at), untrusted.source)
    return c.json({ accepted: rows.length }, 202)
  })

  .get('/v1/challenges/:id', requireDevice(), async (c) => {
    const row = await findChallenge(c.get('db'), c.req.param('id'))
    if (!row || row.deviceId !== c.get('plugin')!.device.id)
      return c.json({ error: 'not_found' }, 404)
    return c.json({
      id: row.id,
      status: challengeStatus(row),
      expires_at: row.expiresAt.toISOString(),
      approved_by: row.approvedBy,
    })
  })

  .get('/challenge/:id', async (c) => {
    const row = await findChallenge(c.get('db'), c.req.param('id'))
    if (!row)
      return c.html(messagePage('Unknown challenge', 'This approval link is not valid.'), 404)
    c.header('Cache-Control', 'no-store')
    return c.html(
      challengePage({ ...row, status: challengeStatus(row) }, await challengeViewer(c, row)),
    )
  })
  .post('/challenge/:id/approve', (c) => decideChallenge(c, 'approve'))
  .post('/challenge/:id/deny', (c) => decideChallenge(c, 'deny'))

  // Connection warm-up of Claude Code; the plugin's local proxy usually answers it itself.
  .get('/llm/api/hello', (c) => c.body(null, 200))
