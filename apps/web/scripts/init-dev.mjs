import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../.dev.vars', import.meta.url))
if (!existsSync(file)) {
  const values = ['JWT_SECRET', 'BETTER_AUTH_SECRET', 'ENCRYPTION_KEY'].map(
    (name) => `${name}=${process.env[name] || randomBytes(32).toString('base64url')}`,
  )
  writeFileSync(file, `${values.join('\n')}\nOPENROUTER_API_KEY=\n`, { flag: 'wx', mode: 0o600 })
  console.log(
    'Created local .dev.vars with development secrets. Add a model API key only if needed.',
  )
}
