import {
  type Db,
  device,
  deviceNetwork,
  dpopJti,
  pluginEvent,
  pluginRefreshToken,
  pluginRejection,
} from '@acl/db'
import { randomId } from '@acl/shared'
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { AppContext } from '../context.ts'

export type DeviceRow = typeof device.$inferSelect

/** The public URL of a gateway path. Proofs are bound to it, not to the internal host. */
export function publicUrl(env: { PUBLIC_URL: string }, path = ''): string {
  return `${env.PUBLIC_URL.replace(/\/+$/, '')}${path}`
}

/** Stores a proof id; false when it was already seen. D1 is the shared replay cache. */
export async function claimJti(db: Db, jti: string, ttlSec: number): Promise<boolean> {
  const now = Date.now()
  // Housekeeping rides along on a small share of requests.
  if (Math.random() < 0.02) await db.delete(dpopJti).where(lt(dpopJti.expiresAt, new Date(now)))
  const stored = await db
    .insert(dpopJti)
    .values({ jti, expiresAt: new Date(now + ttlSec * 1000) })
    .onConflictDoNothing()
    .returning({ jti: dpopJti.jti })
  return stored.length > 0
}

/**
 * Logs a refused credential. With `theft`, a valid credential of `victimDeviceId` was presented
 * with the wrong key or from another machine: the device it belongs to is flagged.
 */
export async function recordRejection(
  db: Db,
  args: {
    ip: string | null
    path: string
    reason: string
    victimDeviceId?: string | null
    presentedJkt?: string | null
    theft?: boolean
  },
): Promise<void> {
  const theft = Boolean(args.theft && args.victimDeviceId)
  await db.insert(pluginRejection).values({
    id: randomId('rej'),
    ip: args.ip,
    path: args.path,
    reason: args.reason,
    theftSuspected: theft,
    victimDeviceId: args.victimDeviceId ?? null,
    presentedJkt: args.presentedJkt ?? null,
  })
  if (theft && args.victimDeviceId)
    await db
      .update(device)
      .set({ theftSuspectedAt: new Date() })
      .where(eq(device.id, args.victimDeviceId))
}

/** An event the gateway derives itself (`source: gateway`). */
export async function recordGatewayEvent(
  db: Db,
  dev: Pick<DeviceRow, 'id' | 'orgId' | 'userId'>,
  type: string,
  data: unknown,
): Promise<void> {
  await db.insert(pluginEvent).values({
    eventId: crypto.randomUUID(),
    orgId: dev.orgId,
    deviceId: dev.id,
    userId: dev.userId,
    type,
    source: 'gateway',
    ts: new Date(),
    data,
  })
}

export async function revokeRefreshTokens(db: Db, deviceId: string): Promise<void> {
  await db
    .update(pluginRefreshToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(pluginRefreshToken.deviceId, deviceId), isNull(pluginRefreshToken.revokedAt)))
}

export type RequestNetwork = {
  ip: string
  country: string | null
  coords: { lat: number; lon: number } | null
}

/** Where a request comes from. Outside Cloudflare (local development) there is one network. */
export function requestNetwork(c: AppContext): RequestNetwork {
  const cf = (c.req.raw as { cf?: { country?: string; latitude?: string; longitude?: string } }).cf
  const lat = Number.parseFloat(cf?.latitude ?? '')
  const lon = Number.parseFloat(cf?.longitude ?? '')
  return {
    ip: c.req.header('cf-connecting-ip') ?? 'unknown',
    country: cf?.country ?? null,
    coords: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
  }
}

type Coords = { lat: number; lon: number }

export function haversineKm(a: Coords, b: Coords): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** The speed a move between two networks implies; null when either place is unknown. */
export function travelKmh(
  prev: { coords: Coords | null; at: number } | null,
  cur: { coords: Coords | null; at: number },
): number | null {
  if (!prev?.coords || !cur.coords) return null
  const hours = Math.max((cur.at - prev.at) / 3_600_000, 1 / 3600)
  return haversineKm(prev.coords, cur.coords) / hours
}

/** Whether the device was on this network before, and how fast it would have had to travel. */
export async function observeNetwork(
  db: Db,
  dev: Pick<DeviceRow, 'id' | 'lastIp' | 'lastNetworkAt'>,
  net: RequestNetwork,
): Promise<{ known: boolean; travelKmh: number | null }> {
  const networks = await db.query.deviceNetwork.findMany({
    where: eq(deviceNetwork.deviceId, dev.id),
  })
  const last =
    dev.lastIp && dev.lastIp !== net.ip ? networks.find((n) => n.ip === dev.lastIp) : null
  return {
    known: networks.some((n) => n.ip === net.ip),
    travelKmh: last
      ? travelKmh(
          {
            coords: last.lat != null && last.lon != null ? { lat: last.lat, lon: last.lon } : null,
            at: (dev.lastNetworkAt ?? last.lastSeenAt).getTime(),
          },
          { coords: net.coords, at: Date.now() },
        )
      : null,
  }
}

/** Marks the request's network as known for the device: after a sign-in or an allowed call. */
export async function touchNetwork(db: Db, deviceId: string, net: RequestNetwork): Promise<void> {
  const now = new Date()
  const seen = { country: net.country, lat: net.coords?.lat, lon: net.coords?.lon, lastSeenAt: now }
  await db
    .insert(deviceNetwork)
    .values({ deviceId, ip: net.ip, ...seen })
    .onConflictDoUpdate({ target: [deviceNetwork.deviceId, deviceNetwork.ip], set: seen })
  await db
    .update(device)
    .set({ lastIp: net.ip, lastNetworkAt: now, lastSeenAt: now })
    .where(eq(device.id, deviceId))
}
