import type {
  CheckResult,
  Decision,
  EventKind,
  GroupPermissions,
  PolicyGraph,
  RateLimitRule,
  WorkflowRef,
} from '@acl/shared'
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamp = () => integer({ mode: 'timestamp_ms' })
const bool = () => integer({ mode: 'boolean' })
const json = <T>() => text({ mode: 'json' }).$type<T>()
const createdAt = () =>
  timestamp()
    .notNull()
    .$defaultFn(() => new Date())
const updatedAt = () =>
  timestamp()
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date())
const emptyList = <T>() =>
  json<T[]>()
    .notNull()
    .$defaultFn(() => [])

// ---------------------------------------------------------------------------
// Better Auth (core + organization plugin)
// ---------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: bool().notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = sqliteTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: timestamp().notNull(),
    token: text().notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp(),
    refreshTokenExpiresAt: timestamp(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
)

export const verification = sqliteTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const organization = sqliteTable('organization', {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: createdAt(),
})

export const member = sqliteTable(
  'member',
  {
    id: text().primaryKey(),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [index('member_org_idx').on(t.organizationId), index('member_user_idx').on(t.userId)],
)

export const invitation = sqliteTable('invitation', {
  id: text().primaryKey(),
  organizationId: text()
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text().notNull(),
  role: text(),
  status: text().notNull().default('pending'),
  expiresAt: timestamp().notNull(),
  inviterId: text()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
})

/** Better Auth SSO plugin. `oidcConfig` holds the client secret, so never send rows to the browser. */
export const ssoProvider = sqliteTable(
  'sso_provider',
  {
    id: text().primaryKey(),
    providerId: text().notNull().unique(),
    issuer: text().notNull(),
    domain: text().notNull(),
    oidcConfig: text(),
    samlConfig: text(),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    organizationId: text().references(() => organization.id, { onDelete: 'cascade' }),
  },
  (t) => [index('sso_provider_org_idx').on(t.organizationId)],
)

// ---------------------------------------------------------------------------
// Devices, plugin login and Claude Code sessions
// ---------------------------------------------------------------------------

export const device = sqliteTable(
  'device',
  {
    id: text().primaryKey(),
    orgId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 of the fingerprint the plugin computes (hardware ids, OS, hostname, keychain key). */
    fingerprintHash: text().notNull(),
    label: text().notNull(),
    platform: text(),
    status: text({ enum: ['trusted', 'pending', 'revoked'] }).notNull(),
    firstSeenIp: text(),
    firstSeenCountry: text(),
    approvedBy: text(),
    approvedAt: timestamp(),
    lastSeenAt: timestamp(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('device_user_fp_uq').on(t.userId, t.fingerprintHash),
    index('device_org_idx').on(t.orgId),
  ],
)

/** OAuth 2.0 device authorization grant (RFC 8628) used by the Claude Code plugin. */
export const deviceCode = sqliteTable('device_code', {
  deviceCodeHash: text().primaryKey(),
  userCode: text().notNull().unique(),
  fingerprintHash: text().notNull(),
  deviceLabel: text().notNull(),
  platform: text(),
  ip: text(),
  country: text(),
  status: text({ enum: ['pending', 'approved', 'denied', 'consumed'] })
    .notNull()
    .default('pending'),
  orgId: text(),
  userId: text(),
  expiresAt: timestamp().notNull(),
  createdAt: createdAt(),
})

export const gatewayRefreshToken = sqliteTable(
  'gateway_refresh_token',
  {
    id: text().primaryKey(),
    tokenHash: text().notNull().unique(),
    orgId: text()
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: text()
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    expiresAt: timestamp().notNull(),
    revokedAt: timestamp(),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_device_idx').on(t.deviceId)],
)

export const ccSession = sqliteTable(
  'cc_session',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    userId: text().notNull(),
    deviceId: text(),
    /** Resource ids the session was scoped to with `/acl resources`; empty means all granted. */
    resourceIds: emptyList<string>(),
    requestCount: integer().notNull().default(0),
    blockedCount: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    status: text({ enum: ['active', 'terminated'] })
      .notNull()
      .default('active'),
    startedAt: createdAt(),
    lastSeenAt: createdAt(),
  },
  (t) => [index('cc_session_org_seen_idx').on(t.orgId, t.lastSeenAt)],
)

// ---------------------------------------------------------------------------
// Traffic history
// ---------------------------------------------------------------------------

export const event = sqliteTable(
  'event',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    orgId: text().notNull(),
    userId: text().notNull(),
    deviceId: text(),
    sessionId: text(),
    kind: text().$type<EventKind>().notNull(),
    model: text(),
    mcpServerId: text(),
    toolName: text(),
    resourceIds: emptyList<string>(),
    decision: text().$type<Decision>().notNull(),
    checks: emptyList<CheckResult>(),
    riskScore: real().notNull().default(0),
    workflows: emptyList<WorkflowRef>(),
    inputTokens: integer(),
    outputTokens: integer(),
    latencyMs: integer().notNull(),
    upstreamStatus: integer(),
    ip: text(),
    country: text(),
    userAgent: text(),
    payloadKey: text(),
    createdAt: timestamp().notNull(),
  },
  (t) => [
    index('event_org_created_idx').on(t.orgId, t.createdAt),
    index('event_org_decision_idx').on(t.orgId, t.decision, t.createdAt),
    index('event_org_user_idx').on(t.orgId, t.userId, t.createdAt),
    index('event_session_idx').on(t.sessionId),
  ],
)

export const approval = sqliteTable(
  'approval',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    eventId: text().notNull(),
    userId: text().notNull(),
    sessionId: text(),
    deviceId: text(),
    kind: text().$type<EventKind>().notNull(),
    summary: text().notNull(),
    reasons: emptyList<string>(),
    /** Approving marks the device as trusted, so later requests skip this approval. */
    trustsDevice: bool().notNull().default(false),
    status: text({ enum: ['pending', 'approved', 'declined', 'expired'] })
      .notNull()
      .default('pending'),
    decidedBy: text(),
    decidedAt: timestamp(),
    expiresAt: timestamp().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('approval_org_status_idx').on(t.orgId, t.status, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

/**
 * A named policy graph. Every enabled workflow whose trigger matches a request and whose groups
 * include the user runs; the strictest outcome wins.
 */
export const workflow = sqliteTable(
  'workflow',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    name: text().notNull(),
    description: text(),
    enabled: bool().notNull().default(true),
    /** Display order, and the order steps show up in an event. */
    position: integer().notNull().default(0),
    /** Groups whose members this workflow runs for. Empty means every member. */
    groupIds: emptyList<string>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('workflow_org_idx').on(t.orgId)],
)

/** Append-only versions of one workflow. Its highest published version is active. */
export const workflowVersion = sqliteTable(
  'workflow_version',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    workflowId: text()
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    definition: json<PolicyGraph>().notNull(),
    status: text({ enum: ['draft', 'published'] }).notNull(),
    note: text(),
    createdBy: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workflow_version_uq').on(t.workflowId, t.version)],
)

export const rateLimit = sqliteTable(
  'rate_limit',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    scope: text().$type<RateLimitRule['scope']>().notNull(),
    target: text().notNull(),
    limit: integer().notNull(),
    windowSec: integer().notNull(),
    per: text().$type<RateLimitRule['per']>().notNull().default('user'),
    enabled: bool().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('rate_limit_org_idx').on(t.orgId)],
)

// ---------------------------------------------------------------------------
// MCP integrations
// ---------------------------------------------------------------------------

export type OAuthConfig = {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  /** Encrypted with ENCRYPTION_KEY. */
  clientSecretEnc: string | null
  scopes: string[]
}

export const mcpServer = sqliteTable(
  'mcp_server',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    /** Prefix for tool names exposed by the aggregator, e.g. `github` -> `github__create_issue`. */
    slug: text().notNull(),
    name: text().notNull(),
    preset: text(),
    url: text().notNull(),
    authType: text({ enum: ['none', 'bearer', 'oauth2'] }).notNull(),
    /** `org`: one shared credential. `user`: every user connects their own account. */
    credentialMode: text({ enum: ['org', 'user'] })
      .notNull()
      .default('user'),
    oauth: json<OAuthConfig>(),
    /** Cached `tools/list` result, refreshed by the gateway. */
    tools: emptyList<{ name: string; description?: string }>(),
    toolsRefreshedAt: timestamp(),
    enabled: bool().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mcp_server_org_slug_uq').on(t.orgId, t.slug)],
)

export const mcpCredential = sqliteTable(
  'mcp_credential',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    mcpServerId: text()
      .notNull()
      .references(() => mcpServer.id, { onDelete: 'cascade' }),
    /** Null for org-wide credentials. */
    userId: text(),
    accessTokenEnc: text().notNull(),
    refreshTokenEnc: text(),
    expiresAt: timestamp(),
    accountLabel: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_credential_user_uq')
      .on(t.mcpServerId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('mcp_credential_org_uq').on(t.mcpServerId).where(sql`${t.userId} is null`),
  ],
)

// ---------------------------------------------------------------------------
// Access model: resources (groups of MCP tools) granted to users or groups
// ---------------------------------------------------------------------------

export const resource = sqliteTable(
  'resource',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    name: text().notNull(),
    description: text(),
    mcpServerId: text().references(() => mcpServer.id, { onDelete: 'cascade' }),
    /** Glob patterns over tool names, e.g. `create_*`. Empty means every tool of the server. */
    toolPatterns: emptyList<string>(),
    createdAt: createdAt(),
  },
  (t) => [index('resource_org_idx').on(t.orgId)],
)

export const group = sqliteTable(
  'group',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    name: text().notNull(),
    description: text(),
    /** Every org member belongs to the default group implicitly; it has no `group_member` rows. */
    isDefault: bool().notNull().default(false),
    permissions: json<GroupPermissions>()
      .notNull()
      .$defaultFn(() => ({ models: [], builtinTools: [] })),
    createdAt: createdAt(),
  },
  (t) => [
    index('group_org_idx').on(t.orgId),
    uniqueIndex('group_org_default_uq').on(t.orgId).where(sql`${t.isDefault} = 1`),
  ],
)

export const groupMember = sqliteTable(
  'group_member',
  {
    groupId: text()
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('group_member_uq').on(t.groupId, t.userId)],
)

export const resourceGrant = sqliteTable(
  'resource_grant',
  {
    resourceId: text()
      .notNull()
      .references(() => resource.id, { onDelete: 'cascade' }),
    subjectType: text({ enum: ['user', 'group'] }).notNull(),
    subjectId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('resource_grant_uq').on(t.resourceId, t.subjectType, t.subjectId)],
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    orgId: text().notNull(),
    actorId: text(),
    action: text().notNull(),
    target: text(),
    data: json<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_org_created_idx').on(t.orgId, t.createdAt)],
)
