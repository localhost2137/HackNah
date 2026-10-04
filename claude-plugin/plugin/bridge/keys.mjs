// Device key providers. A provider holds up to two P-256 keys:
//   routine  - signs every request (DPoP)
//   presence - signs destructive calls; on macOS it requires Touch ID
//
// Providers:
//   secure-enclave (macOS): key generated in the Secure Enclave, non-exportable
//   software (any OS):      PKCS#8 file with 0600 permissions; copyable, so the
//                           platform sees key_storage="software" and can treat it as weaker
// A Linux TPM provider would implement the same interface (see README).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from './config.mjs';
import { info, warn } from './log.mjs';
import { b64url, jwkThumbprint } from './util.mjs';

class SoftwareProvider {
  storage = 'software';
  #keys = {};

  async init() {
    mkdirSync(config.paths.keys, { recursive: true, mode: 0o700 });
    for (const name of ['routine', 'presence']) {
      const path = join(config.paths.keys, `${name}.pem`);
      if (!existsSync(path)) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      }
      const key = createPrivateKey(readFileSync(path));
      const { kty, crv, x, y } = createPublicKey(key).export({ format: 'jwk' });
      this.#keys[name] = { key, jwk: { kty, crv, x, y } };
    }
  }

  publicJwk(name) {
    return this.#keys[name]?.jwk ?? null;
  }

  // Software keys cannot prove user presence.
  hasPresence() {
    return false;
  }

  async sign(name, data, _body) {
    return b64url(sign('sha256', data, { key: this.#keys[name].key, dsaEncoding: 'ieee-p1363' }));
  }
}

class SecureEnclaveProvider {
  storage = 'secure_enclave';
  #jwks = {};
  #proc;
  #pending = new Map();
  #seq = 0;

  constructor(binary) {
    this.binary = binary;
  }

  async init() {
    mkdirSync(config.paths.keys, { recursive: true, mode: 0o700 });
    const specs = [];
    for (const [name, extra] of [['routine', []], ['presence', ['--presence']]]) {
      const path = join(config.paths.keys, `${name}.se`);
      const out = existsSync(path)
        ? runJson(this.binary, ['pubkey', '--key', path])
        : runJson(this.binary, ['create', '--out', path, ...extra]);
      this.#jwks[name] = out.jwk;
      specs.push('--key', `${name}=${path}`);
    }
    // One long-running signer process: no process spawn per request.
    this.#proc = spawn(this.binary, ['serve', ...specs], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.#proc.on('exit', (code) => {
      warn('se-signer exited', { code });
      for (const { reject } of this.#pending.values()) reject(new Error('se-signer exited'));
      this.#pending.clear();
      this.#proc = null;
    });
    const rl = createInterface({ input: this.#proc.stdout });
    await new Promise((resolve, reject) => {
      rl.once('line', (line) => (JSON.parse(line).ready ? resolve() : reject(new Error(line))));
    });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.sig) return p.resolve(msg.sig);
      // -25308 errSecInteractionNotAllowed: keys are usable only while the Mac is unlocked.
      p.reject(
        new Error(
          /-25308/.test(msg.error)
            ? "this Mac is locked: hy-guard's device key only works while the Mac is unlocked (retries succeed after unlocking)"
            : msg.error,
        ),
      );
    });
  }

  publicJwk(name) {
    return this.#jwks[name] ?? null;
  }

  hasPresence() {
    return Boolean(this.#jwks.presence);
  }

  /** `body` is the HTTP body the proof covers; the signer builds the Touch ID prompt from it. */
  sign(name, data, body) {
    if (!this.#proc) return Promise.reject(new Error('se-signer not running'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#proc.stdin.write(`${JSON.stringify({ id, key: name, data: b64url(data), body: body === undefined ? undefined : b64url(body) })}\n`);
    });
  }
}

function runJson(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  if (r.status !== 0 || out.error) throw new Error(`se-signer ${args[0]}: ${out.error ?? r.stderr}`);
  return out;
}

/** Find the prebuilt signer, or compile it once into the data dir (per source version). */
function seSignerBinary() {
  // Named "hy-guard": macOS shows "<executable> is trying to <reason>" in the Touch ID prompt.
  const prebuilt = join(config.pluginRoot, 'native', 'hy-guard');
  if (existsSync(prebuilt)) return prebuilt;
  const source = readFileSync(join(config.pluginRoot, 'native', 'se-signer.swift'));
  const built = join(config.dataDir, 'bin', `${createHash('sha256').update(source).digest('hex').slice(0, 12)}`, 'hy-guard');
  if (existsSync(built)) return built;
  mkdirSync(dirname(built), { recursive: true });
  info('compiling se-signer (first run)');
  const r = spawnSync(
    'swiftc',
    ['-O', join(config.pluginRoot, 'native', 'se-signer.swift'), '-o', built],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`swiftc failed: ${r.stderr || r.error}`);
  chmodSync(built, 0o755);
  return built;
}

export async function loadKeyProvider() {
  const want = config.keyProvider;
  if (want !== 'software' && process.platform === 'darwin') {
    try {
      const bin = seSignerBinary();
      if (runJson(bin, ['probe']).secure_enclave) {
        const p = new SecureEnclaveProvider(bin);
        await p.init();
        return finish(p);
      }
      throw new Error('secure enclave not available');
    } catch (e) {
      if (want === 'secure-enclave') throw e;
      warn('secure enclave unavailable, using software key', { reason: e.message });
    }
  } else if (want === 'secure-enclave') {
    throw new Error('secure-enclave key provider requires macOS');
  }
  const p = new SoftwareProvider();
  await p.init();
  return finish(p);
}

function finish(p) {
  p.thumbprint = jwkThumbprint(p.publicJwk('routine'));
  info('device key ready', { storage: p.storage, jkt: p.thumbprint, presence: p.hasPresence() });
  return p;
}
