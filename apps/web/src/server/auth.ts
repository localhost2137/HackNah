import { type Db, member, schema, ssoProvider, user } from '@acl/db'
import { sso } from '@better-auth/sso'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { organization } from 'better-auth/plugins/organization'
import { defaultAc, defaultStatements, memberAc } from 'better-auth/plugins/organization/access'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { and, eq } from 'drizzle-orm'
import { env } from './env.ts'
import { getInstanceId } from './instance.ts'

/**
 * Identity providers the SSO plugin may fetch discovery documents, tokens and keys from.
 * Self-hosted ones (Keycloak, Authentik, ...) go in the comma-separated `SSO_TRUSTED_ORIGINS` var.
 */
const IDP_ORIGINS = [
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://openidconnect.googleapis.com',
  'https://www.googleapis.com',
  'https://login.microsoftonline.com',
  'https://graph.microsoft.com',
  'https://*.okta.com',
  'https://*.oktapreview.com',
  'https://*.auth0.com',
]

/** Over HTTP only sign-in and the callback are reachable; provider admin goes through server fns. */
const PUBLIC_SSO_PATHS = ['/sign-in/sso', '/sso/callback']

/** The mock identity provider from `pnpm mock:idp`, trusted automatically in development builds. */
const MOCK_IDP_ORIGIN = 'http://localhost:9400'

function selfHostedIdpOrigins(): string[] {
  const configured = env.SSO_TRUSTED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return import.meta.env.DEV ? [...configured, MOCK_IDP_ORIGIN] : configured
}

function idpOrigins(): string[] {
  return [...IDP_ORIGINS, ...selfHostedIdpOrigins()]
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

/** Admins keep password login so a broken IdP configuration can't lock the org out. */
async function isBreakGlassAdmin(db: Db, email: string, orgId: string | null): Promise<boolean> {
  if (!orgId) return false
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, orgId),
        eq(user.email, email.toLowerCase()),
        eq(member.role, 'admin'),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export function createAuth(db: Db) {
  return betterAuth({
    baseURL: env.PUBLIC_URL,
    secret: env.BETTER_AUTH_SECRET,
    // IdP origins are trusted only where the SSO plugin talks to the IdP, so they never become
    // valid post-login redirect targets elsewhere.
    trustedOrigins: (request) => {
      const path = request ? new URL(request.url).pathname : null
      if (!path || path.includes('/sso/')) return [env.PUBLIC_URL, ...idpOrigins()]
      if (path.endsWith('/sign-in/sso')) return [env.PUBLIC_URL, ...selfHostedIdpOrigins()]
      return [env.PUBLIC_URL]
    },
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        ssoProvider: schema.ssoProvider,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Better Auth still recognizes its built-in owner role even with custom roles.
        // Reject it at the API boundary as well as in dashboard validators.
        if (ctx.path.startsWith('/organization/')) {
          if (
            [
              '/organization/create',
              '/organization/delete',
              '/organization/update',
              '/organization/set-active',
            ].includes(ctx.path)
          )
            throw new APIError('FORBIDDEN', { message: 'This is a single-tenant instance.' })
          const orgId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId
          if (orgId !== undefined && orgId !== (await getInstanceId(db)))
            throw new APIError('FORBIDDEN', { message: 'Invalid instance.' })
          const role = (ctx.body as { role?: unknown } | undefined)?.role
          if (role !== undefined && role !== 'admin' && role !== 'member')
            throw new APIError('BAD_REQUEST', { message: 'Role must be admin or member.' })
        }
        const isSsoAdmin =
          ctx.path.startsWith('/sso/') && !PUBLIC_SSO_PATHS.some((p) => ctx.path.startsWith(p))
        if (ctx.request && isSsoAdmin) throw new APIError('NOT_FOUND')

        if (ctx.path === '/sign-in/email' || ctx.path === '/sign-up/email') {
          const email = (ctx.body as { email?: unknown } | undefined)?.email
          if (typeof email !== 'string') return
          const enforced = await db.query.ssoProvider.findFirst({
            where: eq(ssoProvider.domain, emailDomain(email)),
            columns: { organizationId: true },
          })
          if (enforced && !(await isBreakGlassAdmin(db, email, enforced.organizationId)))
            throw new APIError('FORBIDDEN', {
              message: 'This instance requires single sign-on. Use "Continue with SSO".',
            })
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, activeOrganizationId: await getInstanceId(db) },
          }),
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: 'admin',
        roles: { admin: defaultAc.newRole(defaultStatements), member: memberAc },
      }),
      sso({
        organizationProvisioning: { defaultRole: 'member' },
      }),
      tanstackStartCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
