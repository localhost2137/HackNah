import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer } from 'node:http'
import {
  mockIssuer as issuer,
  mockSsoDomain,
  mockIdpPort as port,
  seededSsoUsers,
  subjectFor,
} from './mock-sso.mjs'

// Development-only OIDC identity provider for testing the dashboard's single sign-on.
// It accepts any client ID and secret and signs in whoever you pick. Never expose it.
const users = [
  ...seededSsoUsers,
  { email: `alice@${mockSsoDomain}`, name: 'Alice (SSO)' },
  { email: `bob@${mockSsoDomain}`, name: 'Bob (SSO)' },
]

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = randomBytes(8).toString('hex')
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }

const codes = new Map()
const accessTokens = new Map()
const CODE_TTL_MS = 60_000
const TOKEN_TTL_SEC = 3600

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const sha256 = (value) => createHash('sha256').update(value).digest()
const html = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )

function claimsFor(user) {
  return {
    sub: subjectFor(user.email),
    email: user.email,
    email_verified: true,
    name: user.name,
  }
}

function idToken(user, clientId, nonce) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const payload = b64url(
    JSON.stringify({
      iss: issuer,
      aud: clientId,
      iat: now,
      exp: now + 300,
      ...(nonce ? { nonce } : {}),
      ...claimsFor(user),
    }),
  )
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
  return `${header}.${payload}.${b64url(signature)}`
}

const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  userinfo_endpoint: `${issuer}/userinfo`,
  jwks_uri: `${issuer}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  code_challenge_methods_supported: ['S256'],
  claims_supported: ['sub', 'email', 'email_verified', 'name'],
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string'
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(isJson ? JSON.stringify(body) : body)
}

const oauthError = (res, status, error, description) =>
  send(res, status, { error, error_description: description })

async function readForm(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function redirectBack(res, redirectUri, params) {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value)
  res.writeHead(302, { location: url.toString() })
  res.end()
}

function loginPage(params) {
  const hidden = [
    'client_id',
    'redirect_uri',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ]
    .map((k) => `<input type="hidden" name="${k}" value="${html(params.get(k) ?? '')}">`)
    .join('')
  const buttons = users
    .map(
      (u) =>
        `<form method="post" action="/authorize">${hidden}<input type="hidden" name="email" value="${html(u.email)}"><input type="hidden" name="name" value="${html(u.name)}"><button>Sign in as ${html(u.name)} &lt;${html(u.email)}&gt;</button></form>`,
    )
    .join('')
  return `<!doctype html><meta charset="utf-8"><title>Mock SSO</title>
<style>body{font:14px system-ui;max-width:440px;margin:60px auto;color:#222}h1{font-size:18px}
button{width:100%;padding:9px;margin:4px 0;cursor:pointer}input[type=email],input[type=text]{width:100%;padding:8px;margin:4px 0;box-sizing:border-box}
fieldset{border:1px solid #ddd;margin-top:16px}small{color:#777}</style>
<h1>Mock SSO <small>(development only)</small></h1>
<p><small>Client <code>${html(params.get('client_id'))}</code> wants you to sign in.</small></p>
${buttons}
<fieldset><legend>Someone else</legend><form method="post" action="/authorize">${hidden}
<input type="email" name="email" placeholder="email@sso.test" required>
<input type="text" name="name" placeholder="Display name">
<button>Sign in</button></form></fieldset>
<form method="post" action="/authorize">${hidden}<input type="hidden" name="deny" value="1"><button>Deny</button></form>`
}

function authorize(req, res, params) {
  const redirectUri = params.get('redirect_uri')
  if (!params.get('client_id') || !redirectUri)
    return send(res, 400, '<p>client_id and redirect_uri are required.</p>')
  if (req.method === 'GET') {
    if (params.get('response_type') !== 'code')
      return redirectBack(res, redirectUri, {
        error: 'unsupported_response_type',
        state: params.get('state'),
      })
    return send(res, 200, loginPage(params))
  }
  if (params.get('deny'))
    return redirectBack(res, redirectUri, { error: 'access_denied', state: params.get('state') })

  const email = params.get('email')?.trim().toLowerCase()
  if (!email) return send(res, 400, '<p>Pick a user.</p>')
  const code = b64url(randomBytes(24))
  codes.set(code, {
    user: { email, name: params.get('name')?.trim() || email.split('@')[0] },
    clientId: params.get('client_id'),
    redirectUri,
    nonce: params.get('nonce'),
    challenge: params.get('code_challenge'),
    challengeMethod: params.get('code_challenge_method') || 'plain',
    expiresAt: Date.now() + CODE_TTL_MS,
  })
  console.log(`authorized ${email} for client ${params.get('client_id')}`)
  redirectBack(res, redirectUri, { code, state: params.get('state'), iss: issuer })
}

function clientIdFrom(req, form) {
  const basic = req.headers.authorization?.match(/^Basic (.+)$/i)
  if (basic) return decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':')[0])
  return form.get('client_id')
}

async function token(req, res) {
  const form = await readForm(req)
  if (form.get('grant_type') !== 'authorization_code')
    return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported')
  const entry = codes.get(form.get('code') ?? '')
  codes.delete(form.get('code') ?? '')
  if (!entry || entry.expiresAt < Date.now())
    return oauthError(res, 400, 'invalid_grant', 'Unknown, used or expired code')
  if (entry.redirectUri !== form.get('redirect_uri'))
    return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match')
  const clientId = clientIdFrom(req, form)
  if (clientId !== entry.clientId)
    return oauthError(res, 401, 'invalid_client', 'Client does not match the code')
  if (entry.challenge) {
    const verifier = form.get('code_verifier') ?? ''
    const computed = entry.challengeMethod === 'S256' ? b64url(sha256(verifier)) : verifier
    if (computed !== entry.challenge)
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed')
  }
  const accessToken = b64url(randomBytes(24))
  accessTokens.set(accessToken, { user: entry.user, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 })
  send(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SEC,
    scope: 'openid email profile',
    id_token: idToken(entry.user, clientId, entry.nonce),
  })
}

function userinfo(req, res) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]
  const entry = bearer ? accessTokens.get(bearer) : null
  if (!entry || entry.expiresAt < Date.now())
    return send(res, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer' })
  send(res, 200, claimsFor(entry.user))
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', issuer)
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /.well-known/openid-configuration':
        return send(res, 200, discovery)
      case 'GET /jwks':
        return send(res, 200, { keys: [jwk] })
      case 'GET /authorize':
        return authorize(req, res, url.searchParams)
      case 'POST /authorize':
        return authorize(req, res, await readForm(req))
      case 'POST /token':
        return await token(req, res)
      case 'GET /userinfo':
      case 'POST /userinfo':
        return userinfo(req, res)
      default:
        return send(res, 404, { error: 'not_found' })
    }
  } catch (err) {
    console.error(err)
    send(res, 500, { error: 'server_error' })
  }
}

// `localhost` may resolve to either address family, so listen on both loopbacks only.
for (const host of ['127.0.0.1', '::1']) {
  createServer(handle)
    .on('error', (err) => {
      if (host === '::1' && err.code === 'EADDRNOTAVAIL') return
      console.error(`mock IdP could not listen on ${host}:${port}: ${err.message}`)
      process.exit(1)
    })
    .listen(port, host)
}

console.log(`Mock SSO identity provider at ${issuer}
  Use "Sign in with mock SSO" on the login page (pnpm db:seed registers the provider).
  Needs SSO_TRUSTED_ORIGINS=${issuer} in apps/web/.dev.vars (restart pnpm dev after adding it).`)
