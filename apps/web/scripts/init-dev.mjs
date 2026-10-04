import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../.dev.vars', import.meta.url))

/** The ES256 key the gateway signs its responses to the hy-guard plugin with. */
function responseSigningJwk() {
  if (process.env.RESPONSE_SIGNING_JWK) return process.env.RESPONSE_SIGNING_JWK
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return JSON.stringify(privateKey.export({ format: 'jwk' }))
}

if (!existsSync(file)) {
  const values = ['JWT_SECRET', 'BETTER_AUTH_SECRET', 'ENCRYPTION_KEY'].map(
    (name) => `${name}=${process.env[name] || randomBytes(32).toString('base64url')}`,
  )
  writeFileSync(
    file,
    `${values.join('\n')}\nRESPONSE_SIGNING_JWK=${responseSigningJwk()}\nOPENROUTER_API_KEY=\n`,
    { flag: 'wx', mode: 0o600 },
  )
  console.log(
    'Created local .dev.vars with development secrets. Add a model API key only if needed.',
  )
} else if (!/^\s*RESPONSE_SIGNING_JWK\s*=\s*\S/m.test(readFileSync(file, 'utf8'))) {
  // A .dev.vars from before the plugin protocol: add the key, keep everything else.
  const text = readFileSync(file, 'utf8')
  appendFileSync(
    file,
    `${text.endsWith('\n') || !text ? '' : '\n'}RESPONSE_SIGNING_JWK=${responseSigningJwk()}\n`,
  )
  console.log('Added RESPONSE_SIGNING_JWK to .dev.vars.')
}
