// Device fingerprint and client context, bound into every DPoP proof.
//
//   device  (stable)   hashed into the `dfp` proof claim. A change means a different
//                      machine: with a software key, a copied key; with a hardware key,
//                      something is badly wrong.
//   context (changes)  OS/kernel/Claude Code versions etc., sent as HY-Client-Context and
//                      bound via the `ctxh` claim. Changes are logged, not blocking.
//
// Client-reported values are evidence, not proof: malware can read and replay them.
// The hardware ID is hashed; the platform only needs "same machine or not".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release, totalmem, userInfo } from 'node:os';
import { config } from './config.mjs';
import { b64url, sha256b64url, stableStringify } from './util.mjs';

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const read = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};

function machineId() {
  if (process.platform === 'darwin')
    return /"IOPlatformUUID" = "([^"]+)"/.exec(run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1] ?? '';
  if (process.platform === 'linux') return read('/etc/machine-id') || read('/var/lib/dbus/machine-id');
  if (process.platform === 'win32')
    return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']))?.[1] ?? '';
  return '';
}

function hardwareModel() {
  if (process.platform === 'darwin') return run('sysctl', ['-n', 'hw.model']);
  if (process.platform === 'linux') return read('/sys/class/dmi/id/product_name');
  return '';
}

function osVersion() {
  if (process.platform === 'darwin') return `macOS ${run('sw_vers', ['-productVersion'])}`;
  if (process.platform === 'linux') return /PRETTY_NAME="?([^"\n]+)/.exec(read('/etc/os-release'))?.[1] ?? 'Linux';
  return platform();
}

let device;
/** Stable hardware facts. Computed once per process. */
export function deviceFingerprint() {
  if (device) return device;
  // Demo only: pretend to be another machine (see scripts/steal-session.sh --copy-key).
  const id = config.simulateMachineId || machineId();
  device = {
    machine_id_hash: id ? sha256b64url(`hy-guard-machine:${id}`) : null,
    hardware_model: hardwareModel() || null,
    cpu_model: cpus()[0]?.model ?? null,
    cpu_count: cpus().length,
    memory_gb: Math.round(totalmem() / 2 ** 30),
    os_family: platform(),
    arch: arch(),
  };
  return device;
}

/** `dfp` claim: hash over the stable fingerprint. */
export const deviceFingerprintHash = () => sha256b64url(stableStringify(deviceFingerprint()));

let idleCache = { at: 0, value: null };
/**
 * Seconds since the last keyboard/mouse input (macOS), or null where unknown.
 * Signed into every proof as `idle`. Cached for 10 s (ioreg takes ~20 ms).
 */
export function userIdleSeconds() {
  if (Date.now() - idleCache.at < 10_000) return idleCache.value;
  let value = null;
  if (process.platform === 'darwin') {
    const ns = /"HIDIdleTime" = (\d+)/.exec(run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))?.[1];
    if (ns) value = Math.floor(Number(ns) / 1e9);
  }
  if (config.simulateIdleSeconds !== null) value = config.simulateIdleSeconds;
  idleCache = { at: Date.now(), value };
  return value;
}

let baseContext;
/** Changing facts. `client` is Claude Code's name/version when the process knows it. */
export function clientContext(client) {
  baseContext ??= {
    os_version: osVersion(),
    kernel: release(),
    hostname: hostname(),
    os_user: userInfo().username,
    node: process.versions.node,
    bridge: config.version,
    key_storage: null, // filled by caller
  };
  return { ...baseContext, client: client ?? null };
}

/** Header value + `ctxh` claim for a context object. */
export function encodeContext(ctx) {
  const json = stableStringify(ctx);
  return { header: b64url(json), hash: sha256b64url(json) };
}
