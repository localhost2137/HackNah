import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const sha256 = (data) => createHash('sha256').update(data).digest();
export const sha256b64url = (data) => b64url(sha256(data));
export const randomId = (bytes = 16) => b64url(randomBytes(bytes));
export const uuid = () => randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON with sorted object keys, so equal values always hash the same. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** RFC 7638 JWK thumbprint for an EC P-256 public key. */
export function jwkThumbprint(jwk) {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return sha256b64url(canonical);
}

/**
 * Human-comparable device code shown in Claude Code and on the approval page:
 * the first 60 bits of the key thumbprint as base32 (A-Z, 2-7), e.g. "PTQF-7KVA-3M2Q".
 * Display only, never used for authentication. 60 bits makes generating a key with a
 * matching code (to trick someone into approving the wrong device) impractical.
 */
export function shortCode(thumbprint) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = Buffer.from(thumbprint, 'base64url');
  let bits = '';
  for (const b of bytes.subarray(0, 8)) bits += b.toString(2).padStart(8, '0');
  const chars = Array.from({ length: 12 }, (_, i) => alphabet[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic write (tmp + rename) with owner-only permissions. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Glob with `*` wildcards only, matched against the whole tool name. */
export function globMatch(pattern, name) {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/**
 * Cross-process lock (mkdir is atomic). Stale after 90 s, long enough for a Touch ID
 * prompt. Returns a release function.
 */
export async function acquireLock(dir, { staleMs = 90_000, waitMs = 95_000 } = {}) {
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      mkdirSync(dir);
      return () => {
        try {
          rmdirSync(dir);
        } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(dir).mtimeMs > staleMs) rmdirSync(dir);
      } catch {}
      if (Date.now() > deadline) throw new Error('timed out waiting for refresh lock');
      await sleep(150);
    }
  }
}
