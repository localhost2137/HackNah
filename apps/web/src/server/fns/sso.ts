import { type Db, organization, ssoProvider } from '@acl/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit.ts'
import { env } from '../env.ts'
import { adminMiddleware } from '../middleware.ts'

const DOMAIN = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/

async function providerIdFor(db: Db, orgId: string): Promise<string> {
  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
    columns: { slug: true },
  })
  return `sso-${org?.slug ?? orgId}`
}

function callbackUrl(providerId: string): string {
  return `${env.PUBLIC_URL.replace(/\/$/, '')}/api/auth/sso/callback/${providerId}`
}

/** The org's OIDC provider without the client secret, plus the callback URL to give the IdP. */
export const getSsoProvider = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId } }) => {
    const row = await db.query.ssoProvider.findFirst({
      where: eq(ssoProvider.organizationId, orgId),
    })
    const providerId = row?.providerId ?? (await providerIdFor(db, orgId))
    const config = row?.oidcConfig ? (JSON.parse(row.oidcConfig) as { clientId?: string }) : null
    return {
      callbackUrl: callbackUrl(providerId),
      provider: row
        ? {
            providerId: row.providerId,
            issuer: row.issuer,
            domain: row.domain,
            clientId: config?.clientId ?? '',
          }
        : null,
    }
  })

export const saveSsoProvider = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      issuer: z.url().startsWith('https://', 'The issuer must use https'),
      domain: z
        .string()
        .trim()
        .toLowerCase()
        .transform((d) => d.replace(/^@/, ''))
        .pipe(z.string().regex(DOMAIN, 'Enter a bare email domain, e.g. acme.com')),
      clientId: z.string().trim().min(1),
      clientSecret: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context: { db, orgId, auth, user: me } }) => {
    const taken = await db.query.ssoProvider.findFirst({
      where: and(eq(ssoProvider.domain, data.domain), ne(ssoProvider.organizationId, orgId)),
      columns: { id: true },
    })
    if (taken) throw new Error(`${data.domain} already uses SSO in another organization`)

    const previous = await db.query.ssoProvider.findFirst({
      where: eq(ssoProvider.organizationId, orgId),
    })
    const providerId = previous?.providerId ?? (await providerIdFor(db, orgId))
    // One provider per org: replace it, and put the old one back if the new config is rejected.
    if (previous) await db.delete(ssoProvider).where(eq(ssoProvider.id, previous.id))
    try {
      await auth.api.registerSSOProvider({
        body: {
          providerId,
          issuer: data.issuer.replace(/\/$/, ''),
          domain: data.domain,
          organizationId: orgId,
          oidcConfig: {
            clientId: data.clientId,
            clientSecret: data.clientSecret,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        },
        headers: getRequest().headers,
      })
    } catch (err) {
      if (previous) await db.insert(ssoProvider).values(previous)
      throw new Error(err instanceof Error ? err.message : 'The identity provider was rejected')
    }
    await audit(db, {
      orgId,
      actorId: me.id,
      action: previous ? 'sso.update' : 'sso.create',
      target: providerId,
      data: { issuer: data.issuer, domain: data.domain },
    })
  })

export const deleteSsoProvider = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .handler(async ({ context: { db, orgId, user: me } }) => {
    const [removed] = await db
      .delete(ssoProvider)
      .where(eq(ssoProvider.organizationId, orgId))
      .returning({ providerId: ssoProvider.providerId })
    if (removed)
      await audit(db, { orgId, actorId: me.id, action: 'sso.delete', target: removed.providerId })
  })
