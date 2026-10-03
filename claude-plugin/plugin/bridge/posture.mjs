// Device posture from the EDR, read locally like Okta Verify / Zscaler Client Connector do.
//
// CrowdStrike Falcon keeps its Zero Trust Assessment (ZTA) for this host in a local file,
// as a JWT (score: assessment.overall/os/sensor_config, agent ID). The bridge sends it with
// each request (HY-Posture-ZTA) and binds it to the device key by putting its hash into the
// DPoP proof (claim `ztah`). The platform verifies the token and applies posture rules.
//
// HY_ZTA_FILE overrides the location (demo: scripts/zta.mjs writes a mock token).

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { config } from './config.mjs';

const DEFAULT_PATHS = {
  darwin: '/Library/Application Support/Crowdstrike/ZeroTrustAssessment/data.zta',
  win32: `${process.env.ProgramData ?? 'C:\\ProgramData'}\\CrowdStrike\\ZeroTrustAssessment\\data.zta`,
};

let cache = { path: null, mtimeMs: 0, token: null };

/** Current ZTA token (JWT string) or null when there is none. Re-read only when the file changes. */
export function ztaToken() {
  const path = config.ztaFile || DEFAULT_PATHS[process.platform];
  if (!path) return null;
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache = { path, mtimeMs: 0, token: null };
    return null;
  }
  if (cache.path === path && cache.mtimeMs === mtimeMs) return cache.token;
  let token = null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (/^[\w-]+\.[\w-]+\.[\w-]*$/.test(raw)) token = raw; // JWT shape only
  } catch {}
  cache = { path, mtimeMs, token };
  return token;
}

// ---------- built-in OS posture (for companies without an EDR) ----------
// Client-reported, signed into each proof as `osp`. Malware with admin rights could fake
// it; it's a baseline for small organisations, the EDR is the stronger source.

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  }
};

let osCache = { at: 0, value: null };
const OS_POSTURE_TTL_MS = 5 * 60_000;

/**
 * { fv: FileVault on, sip: System Integrity Protection on, gk: Gatekeeper on, fw: firewall on }
 * true/false, or null when unknown. macOS only for now; null elsewhere.
 */
export function osPosture() {
  if (Date.now() - osCache.at < OS_POSTURE_TTL_MS) return osCache.value;
  let value = null;
  if (process.platform === 'darwin') {
    const on = (out, yes, no) => (yes.test(out) ? true : no.test(out) ? false : null);
    value = {
      fv: on(sh('fdesetup', ['status']), /FileVault is On/, /FileVault is Off/),
      sip: on(sh('csrutil', ['status']), /status: enabled/, /status: disabled/),
      gk: on(sh('spctl', ['--status']), /assessments enabled/, /assessments disabled/),
      fw: on(sh('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']), /enabled/, /disabled/),
    };
  }
  // Demo only: HY_SIMULATE_OS_POSTURE="fv=0,sip=0" overrides individual checks.
  if (config.simulateOsPosture) {
    value = { ...(value ?? { fv: null, sip: null, gk: null, fw: null }) };
    for (const pair of config.simulateOsPosture.split(',')) {
      const [k, v] = pair.split('=');
      if (k in value) value[k] = v === '1';
    }
  }
  osCache = { at: Date.now(), value };
  return value;
}

/** Local reading of the ZTA score, for display only (the platform verifies the token). */
export function ztaScore() {
  const t = ztaToken();
  if (!t) return null;
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).assessment?.overall ?? null;
  } catch {
    return null;
  }
}
