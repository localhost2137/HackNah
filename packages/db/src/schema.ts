import type {
  CheckResult,
  Decision,
  EventKind,
  GroupPermissions,
  GuardrailRef,
  LimitRule,
  PolicyGraph,
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

/** What a plugin device reports about its software with every request. */
export type DeviceContext = {
  os_version?: string
  kernel?: string
  hostname?: string
  os_user?: string
  node?: string
  bridge?: string
  key_storage?: string
  client?: { name?: string; version?: string } | null
}

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
    // --- Devices signed in through the plugin's key-bound flow (DPoP). Null on other devices. ---
    /** RFC 7638 thumbprint of the device's routine key; its tokens only work with this key. */
    jkt: text(),
    jwk: json<Record<string, string>>(),
    /** The Touch ID key, when the device registered one. */
    presenceJkt: text(),
    presenceJwk: json<Record<string, string>>(),
    keyStorage: text(),
    /** Display-only code the user compares with Claude Code; never an authenticator. */
    shortCode: text(),
    /** The fingerprint fields behind `fingerprintHash`, as sent at sign-in. */
    fingerprintDetails: json<Record<string, string | number>>(),
    /** Latest `HY-Client-Context` (OS, kernel, Claude Code version). */
    context: json<DeviceContext>(),
    /** A valid token or refresh token of this device was presented with another key or machine. */
    theftSuspectedAt: timestamp(),
    /** When the session last read untrusted content, and what it read. */
    untrustedAt: timestamp(),
    untrustedSource: text(),
    /** The network of the last allowed request, for travel speed. */
    lastIp: text(),
    lastNetworkAt: timestamp(),
  },
  (t) => [
    uniqueIndex('device_user_fp_uq').on(t.userId, t.fingerprintHash),
    index('device_org_idx').on(t.orgId),
    uniqueIndex('device_jkt_uq').on(t.jkt),
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

// ---------------------------------------------------------------------------
// hy-guard plugin protocol (claude-plugin/docs/BACKEND_CONTRACT.md)
// ---------------------------------------------------------------------------

/** OAuth authorization codes of the plugin sign-in: single use, valid for 60 s. */
export const pluginAuthCode = sqliteTable('plugin_auth_code', {
  codeHash: text().primaryKey(),
  clientId: text().notNull(),
  redirectUri: text().notNull(),
  codeChallenge: text().notNull(),
  dpopJkt: text().notNull(),
  orgId: text().notNull(),
  userId: text().notNull(),
  deviceName: text().notNull(),
  platform: text(),
  keyStorage: text(),
  expiresAt: timestamp().notNull(),
  createdAt: createdAt(),
})

/** Refresh tokens bound to a device key. Only the hash is stored. */
export const pluginRefreshToken = sqliteTable(
  'plugin_refresh_token',
  {
    id: text().primaryKey(),
    tokenHash: text().notNull().unique(),
    orgId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: text()
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    jkt: text().notNull(),
    expiresAt: timestamp().notNull(),
    /** Refreshing after this needs a Touch ID proof, or a new sign-in without a presence key. */
    unlockedUntil: timestamp().notNull(),
    revokedAt: timestamp(),
    createdAt: createdAt(),
  },
  (t) => [index('plugin_refresh_device_idx').on(t.deviceId)],
)

/** A tool call waiting for its owner to approve it in the browser after a fresh sign-in. */
export const pluginChallenge = sqliteTable(
  'plugin_challenge',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    deviceId: text()
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    tool: text().notNull(),
    description: text(),
    tier: text(),
    arguments: json<unknown>(),
    /** SHA-256 of canonical `{tool, arguments}`; the retry must carry the same action. */
    actionHash: text().notNull(),
    reasons: emptyList<string>(),
    deviceName: text(),
    deviceCode: text(),
    keyStorage: text(),
    claudeSessionId: text(),
    ip: text(),
    country: text(),
    postureScore: integer(),
    status: text({ enum: ['pending', 'approved', 'denied'] })
      .notNull()
      .default('pending'),
    approvedBy: text(),
    approvedAt: timestamp(),
    expiresAt: timestamp().notNull(),
    usedAt: timestamp(),
    /** The gateway event of the call that was challenged (`decision_id`). */
    eventId: text(),
    createdAt: createdAt(),
  },
  (t) => [index('plugin_challenge_device_idx').on(t.deviceId, t.createdAt)],
)

/** Networks a device was seen on. */
export const deviceNetwork = sqliteTable(
  'device_network',
  {
    deviceId: text()
      .notNull()
      .references(() => device.id, { onDelete: 'cascade' }),
    ip: text().notNull(),
    country: text(),
    lat: real(),
    lon: real(),
    firstSeenAt: createdAt(),
    lastSeenAt: timestamp().notNull(),
  },
  (t) => [uniqueIndex('device_network_uq').on(t.deviceId, t.ip)],
)

/** Telemetry the plugin and its hooks send, and what the gateway derives. At-least-once. */
export const pluginEvent = sqliteTable(
  'plugin_event',
  {
    eventId: text().primaryKey(),
    orgId: text().notNull(),
    deviceId: text().notNull(),
    userId: text().notNull(),
    type: text().notNull(),
    source: text(),
    ts: timestamp().notNull(),
    context: json<unknown>(),
    data: json<unknown>(),
    receivedAt: createdAt(),
  },
  (t) => [index('plugin_event_device_idx').on(t.deviceId, t.ts)],
)

/** DPoP proof ids seen in the last 5 minutes (replay cache). */
export const dpopJti = sqliteTable(
  'dpop_jti',
  {
    jti: text().primaryKey(),
    expiresAt: timestamp().notNull(),
  },
  (t) => [index('dpop_jti_expires_idx').on(t.expiresAt)],
)

/** Refused credentials. `theftSuspected`: a valid token came with the wrong key or machine. */
export const pluginRejection = sqliteTable(
  'plugin_rejection',
  {
    id: text().primaryKey(),
    ip: text(),
    path: text().notNull(),
    reason: text().notNull(),
    theftSuspected: bool().notNull().default(false),
    victimDeviceId: text(),
    presentedJkt: text(),
    createdAt: createdAt(),
  },
  (t) => [index('plugin_rejection_created_idx').on(t.createdAt)],
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
    /** One user turn: the prompt and everything it led to. Null on rows from before 0014. */
    traceId: text(),
    kind: text().$type<EventKind>().notNull(),
    model: text(),
    mcpServerId: text(),
    toolName: text(),
    resourceIds: emptyList<string>(),
    decision: text().$type<Decision>().notNull(),
    checks: emptyList<CheckResult>(),
    riskScore: real().notNull().default(0),
    guardrails: emptyList<GuardrailRef>(),
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),
    costUsd: real(),
    gpuMs: integer(),
    latencyMs: integer().notNull(),
    /** Time spent in the control layer itself, without the upstream. */
    overheadMs: integer(),
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
    index('event_trace_idx').on(t.traceId),
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
 * A named policy graph. Every enabled guardrail whose trigger matches a request and whose groups
 * include the user runs; the strictest outcome wins.
 */
export const guardrail = sqliteTable(
  'guardrail',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    name: text().notNull(),
    description: text(),
    enabled: bool().notNull().default(true),
    /** Display order, and the order steps show up in an event. */
    position: integer().notNull().default(0),
    /** Groups whose members this guardrail runs for. Empty means every member. */
    groupIds: emptyList<string>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('guardrail_org_idx').on(t.orgId)],
)

/** Append-only versions of one guardrail. Its highest published version is active. */
export const guardrailVersion = sqliteTable(
  'guardrail_version',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    guardrailId: text()
      .notNull()
      .references(() => guardrail.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    definition: json<PolicyGraph>().notNull(),
    status: text({ enum: ['draft', 'published'] }).notNull(),
    note: text(),
    createdBy: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('guardrail_version_uq').on(t.guardrailId, t.version)],
)

/** Limits page: request rates, concurrency and budgets. The table keeps its original name. */
export const rateLimit = sqliteTable(
  'rate_limit',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    name: text().notNull().default(''),
    measure: text().$type<LimitRule['measure']>().notNull().default('requests'),
    scope: text().$type<LimitRule['scope']>().notNull(),
    target: text().notNull(),
    /** Requests, tokens, USD or GPU-seconds; USD limits are fractional. */
    limit: real().notNull(),
    windowSec: integer().notNull(),
    per: text().$type<LimitRule['per']>().notNull().default('user'),
    groupId: text(),
    action: text().$type<LimitRule['action']>().notNull().default('block'),
    warnAtPct: integer().notNull().default(80),
    enabled: bool().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('rate_limit_org_idx').on(t.orgId)],
)

/** Model catalog: where each model is served, what it costs, and so what groups may pick. */
export const model = sqliteTable(
  'model',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    pattern: text().notNull(),
    label: text().notNull().default(''),
    kind: text({ enum: ['external', 'local'] })
      .notNull()
      .default('external'),
    apiFormat: text({ enum: ['anthropic', 'openai'] })
      .notNull()
      .default('anthropic'),
    baseUrl: text().notNull().default(''),
    upstreamModel: text().notNull().default(''),
    /** Encrypted with ENCRYPTION_KEY; null uses the gateway's own upstream key. */
    apiKeyEnc: text(),
    inputUsdPerMTok: real().notNull().default(0),
    outputUsdPerMTok: real().notNull().default(0),
    cacheWriteUsdPerMTok: real().notNull().default(0),
    cacheReadUsdPerMTok: real().notNull().default(0),
    gpuUsdPerHour: real().notNull().default(0),
    enabled: bool().notNull().default(true),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('model_org_idx').on(t.orgId)],
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
    /**
     * Admin pins: tool name -> hash of the definition an admin reviewed, as the gateway lists it
     * (`{name, description, inputSchema}`). A pinned tool whose definition differs is reported.
     */
    toolPins: json<Record<string, string>>(),
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
    /**
     * The tools in the bundle: MCP server id (or `*` for every server) to glob patterns over its
     * tool names, e.g. `{ "srv_github": ["create_*"], "srv_jira": ["*"] }`.
     */
    tools: json<Record<string, string[]>>()
      .notNull()
      .$defaultFn(() => ({})),
    /** Unused since `tools`; kept because SQLite cannot drop a column with a foreign key. */
    mcpServerId: text().references(() => mcpServer.id, { onDelete: 'cascade' }),
    /** Unused since `tools`. */
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
      .$defaultFn(() => ({ models: [], builtinTools: [], mcp: {} })),
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

/** Monotonic revision maintained by policy-table triggers; reverting a rule cannot revive runs. */
export const analysisRevision = sqliteTable('analysis_revision', {
  orgId: text().primaryKey(),
  revision: integer().notNull().default(0),
})

/** Large evaluation payloads live in R2; D1 holds the searchable, revision-scoped index. */
export const analysisRun = sqliteTable(
  'analysis_run',
  {
    id: text().primaryKey(),
    orgId: text().notNull(),
    datasetId: text().notNull(),
    revision: integer().notNull(),
    catalogVersion: text().notNull(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    total: integer().notNull(),
    correct: integer().notNull(),
    payloadKey: text().notNull(),
  },
  (t) => [index('analysis_run_scope_idx').on(t.orgId, t.revision, t.catalogVersion, t.createdAt)],
)
