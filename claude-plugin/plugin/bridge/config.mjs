import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ?? fileURLToPath(new URL('../', import.meta.url));

// Claude Code substitutes ${user_config.*} into env; an unset option can arrive
// as an empty string, so treat '' as "not set".
const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const dataDir = env('HY_DATA_DIR', env('CLAUDE_PLUGIN_DATA', join(homedir(), '.hy-guard')));

export const config = {
  version: '0.1.0',
  pluginRoot,
  dataDir,
  /**
   * Base URL of the platform. Everything else is discovered from it.
   * An explicit HY_PLATFORM_URL in the environment (launcher, tests) wins over the
   * plugin's userConfig value, which .mcp.json passes as HY_PLATFORM_URL_CONFIG.
   */
  platformUrl: env('HY_PLATFORM_URL', env('HY_PLATFORM_URL_CONFIG', 'http://127.0.0.1:8787')).replace(/\/+$/, ''),
  /** auto | secure-enclave | software (same precedence as platformUrl) */
  keyProvider: env('HY_KEY_PROVIDER', env('HY_KEY_PROVIDER_CONFIG', 'auto')),
  /** Use the Touch ID key for destructive tools when it exists. */
  presence: env('HY_PRESENCE', 'auto') !== 'off',
  /** Start login automatically when the bridge has no token. */
  autoLogin: env('HY_AUTO_LOGIN', '1') !== '0',
  /** Command used to open URLs; tests swap in a headless fetcher. */
  browserCmd: env('HY_BROWSER_CMD', process.platform === 'darwin' ? 'open' : 'xdg-open'),
  /** Send argument values in telemetry (off: only keys and sizes). */
  telemetryValues: env('HY_TELEMETRY_VALUES', '0') === '1',
  /** Local model-API proxy port (ANTHROPIC_BASE_URL=http://127.0.0.1:<port>). */
  llmPort: Number(env('HY_LLM_PORT', '47821')),
  /** Demo only: use tokens bound to another key (see scripts/steal-session.sh). */
  simulateStolen: env('HY_SIMULATE_STOLEN', '0') === '1',
  /** Demo only: send X-Mock-Client-IP so the mock sees another network. */
  simulateIp: env('HY_SIMULATE_IP', ''),
  /** Demo only: pretend to be another machine (different hardware ID in the fingerprint). */
  simulateMachineId: env('HY_SIMULATE_MACHINE_ID', ''),
  /** Demo only: report this keyboard/mouse idle time instead of the real one. */
  simulateIdleSeconds: env('HY_SIMULATE_IDLE', '') === '' ? null : Number(process.env.HY_SIMULATE_IDLE),
  /** CrowdStrike ZTA file; default is the sensor's own path (see posture.mjs). */
  ztaFile: env('HY_ZTA_FILE', ''),
  /** Demo only: override OS posture checks, e.g. "fv=0,sip=0" (FileVault off, SIP off). */
  simulateOsPosture: env('HY_SIMULATE_OS_POSTURE', ''),
  /** Signed platform responses: auto (verify when the platform publishes a key) | require | off */
  responseSignatures: env('HY_RESPONSE_SIGNATURES', 'auto'),
  /** Pin the platform's response-signing key out of band (thumbprint); otherwise first use pins it. */
  platformKeyJkt: env('HY_PLATFORM_KEY_JKT', ''),
  /** Browser approvals: "open" the page right away (default) or ask in a Claude Code "dialog" first. */
  browserApproval: env('HY_BROWSER_APPROVAL', 'open'),
  /** Demo/test only: skip local argument rules, like a patched client would. */
  simulateSkipLocalRules: env('HY_SIMULATE_SKIP_LOCAL_RULES', '0') === '1',
  clientId: 'hy-cc-plugin',
  deviceName: env('HY_DEVICE_NAME', hostname()),
  projectDir: env('CLAUDE_PROJECT_DIR', process.cwd()),
  paths: {
    keys: join(dataDir, 'keys'),
    tokens: join(dataDir, 'tokens.json'),
    policyCache: join(dataDir, 'policy-cache.json'),
    pins: join(dataDir, 'pins.json'),
    platformKeyPin: join(dataDir, 'platform-key.json'),
    hookSpool: join(dataDir, 'hook-events.jsonl'),
    hookRefs: join(dataDir, 'hook-refs'),
    refreshLock: join(dataDir, 'refresh.lock'),
    log: join(dataDir, 'bridge.log'),
    llmSecret: join(dataDir, 'llm-local-secret.json'),
    uiState: join(dataDir, 'ui-state.json'),
    // One file per Claude Code session, so two open sessions choose their servers separately.
    mcpSelection: join(dataDir, 'mcp-selection', `${env('CLAUDE_CODE_SESSION_ID', 'default').replace(/[^\w-]/g, '')}.json`),
    userRules: join(homedir(), '.config', 'hy-guard', 'rules.json'),
  },
};
