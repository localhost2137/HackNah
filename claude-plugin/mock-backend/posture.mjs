// EDR posture: verify the CrowdStrike Zero Trust Assessment (ZTA) token a device sends.
//
// Real Falcon sensors write data.zta (a JWT with assessment.overall/os/sensor_config and the
// agent ID). How to verify its signature isn't publicly documented, so the mock signs its
// own tokens with a local "CrowdStrike" key (scripts/zta.mjs) and verifies against that.
// For real tokens: ZTA_SIGNATURE=unverified, and cross-check the score with the Falcon API
// by agent ID (GET /zero-trust-assessment/entities/assessments/v1?ids=<aid>).
//
// env: ZTA_CID (expected tenant, default the mock's; "*" = any)
//      ZTA_SIGNATURE=mock|unverified   ZTA_MAX_AGE_MIN=1440

import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOCK_CID = 'mock0cid0000000000000000000000001';
const KEY_FILE = process.env.MOCK_CROWDSTRIKE_KEY ?? join(dirname(fileURLToPath(import.meta.url)), '.data', 'mock-crowdstrike-key.pem');
const EXPECTED_CID = process.env.ZTA_CID ?? MOCK_CID;
const SIGNATURE_MODE = process.env.ZTA_SIGNATURE ?? 'mock';
const MAX_AGE_S = Number(process.env.ZTA_MAX_AGE_MIN ?? 1440) * 60;

/** The mock "CrowdStrike" signing key (created on first use). */
export function mockCrowdStrikeKey() {
  if (!existsSync(KEY_FILE)) {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(KEY_FILE));
}

const json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verify a ZTA token. Returns { ok, reason?, aid, cid, score, os, sensor_config, iat }.
 * `ok: false` means the token itself is bad (forged, other tenant, expired).
 */
export function verifyZta(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed ZTA token' };
  let header;
  let payload;
  try {
    header = json(parts[0]);
    payload = json(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed ZTA token' };
  }
  if (SIGNATURE_MODE === 'mock') {
    const valid =
      header.alg === 'ES256' &&
      verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: createPublicKey(mockCrowdStrikeKey()), dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      );
    if (!valid) return { ok: false, reason: 'ZTA signature invalid' };
  }
  const a = payload.assessment ?? {};
  const out = {
    aid: payload.aid ?? null,
    cid: payload.cid ?? null,
    score: Number.isFinite(a.overall) ? a.overall : null,
    os: a.os ?? null,
    sensor_config: a.sensor_config ?? null,
    iat: payload.iat ?? null,
    signature: SIGNATURE_MODE === 'mock' ? 'verified (mock key)' : 'unverified',
  };
  if (!out.aid || out.score === null) return { ok: false, reason: 'ZTA token without agent ID or score', ...out };
  if (EXPECTED_CID !== '*' && out.cid !== EXPECTED_CID) return { ok: false, reason: 'ZTA token from another CrowdStrike tenant', ...out };
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return { ok: false, reason: 'ZTA token expired', ...out };
  if (out.iat && now - out.iat > MAX_AGE_S) return { ok: true, stale: true, ...out };
  return { ok: true, ...out };
}
