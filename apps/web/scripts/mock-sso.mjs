import { createHash } from 'node:crypto'

// Shared by the mock identity provider and the seed, so seeded accounts match what it signs in.
export const mockIdpPort = Number(process.env.MOCK_IDP_PORT) || 9400
export const mockIssuer = `http://localhost:${mockIdpPort}`
export const mockSsoDomain = 'sso.test'
export const mockClient = { id: 'mock-client', secret: 'mock-secret' }

/** Created and linked to the mock provider by `pnpm db:seed`. */
export const seededSsoUsers = [
  { email: `admin@${mockSsoDomain}`, name: 'Admin (SSO)', role: 'admin' },
  { email: `member@${mockSsoDomain}`, name: 'Member (SSO)', role: 'member' },
]

/** Stable per email, so the same person maps to the same dashboard account across restarts. */
export const subjectFor = (email) =>
  `mock-${createHash('sha256').update(email.toLowerCase()).digest('base64url').slice(0, 16)}`
