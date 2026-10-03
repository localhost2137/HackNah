// `main.mjs serve`: the MCP stdio server Claude Code starts via .mcp.json.

import { config } from './config.mjs';
import { error, info } from './log.mjs';
import { McpServer } from './mcp-server.mjs';
import { PolicyEngine } from './policy.mjs';
import { Telemetry } from './telemetry.mjs';
import { Upstream } from './upstream.mjs';
import { osPosture, ztaScore } from './posture.mjs';
import { uiIdentity, writeDataDirPointer } from './ui-state.mjs';
import { shortCode, uuid } from './util.mjs';

export async function serve(keys, platform) {
  const upstream = new Upstream(platform);
  const policy = new PolicyEngine();
  const telemetry = new Telemetry(platform, {
    instance_id: uuid(),
    device_jkt: keys.thumbprint,
    key_storage: keys.storage,
    os: process.platform,
    bridge_version: config.version,
    project: config.projectDir,
  });
  const server = new McpServer({ platform, upstream, policy, telemetry, keys });

  /** Status-line facts for the in-Claude-Code UI. */
  function publishIdentity() {
    const t = platform.tokens;
    uiIdentity({
      signed_in: Boolean(t),
      user: t?.user?.email ?? null,
      device_code: shortCode(keys.thumbprint),
      key_storage: keys.storage,
      posture: { zta: ztaScore(), os: osPosture() },
    });
  }

  async function refreshPolicy() {
    publishIdentity();
    if (!platform.isSignedIn()) return;
    try {
      const r = await platform.getPolicy(policy.etag);
      if (r) {
        const changed = r.policy.version !== policy.policy.version;
        policy.setPolicy(r.policy, r.etag);
        telemetry.start(r.policy.telemetry?.flush_seconds ?? 5);
        if (changed) {
          info('policy updated', { version: r.policy.version });
          server.notifyToolsChanged();
        }
      }
    } catch (e) {
      if (e.code !== 'auth_required') error('policy refresh failed', { error: e.message });
    }
  }

  platform.onAuthChange = async (signedIn) => {
    publishIdentity();
    upstream.reset();
    telemetry.emit(signedIn ? 'signed_in' : 'signed_out');
    if (signedIn) await refreshPolicy();
    server.notifyToolsChanged();
  };

  process.on('unhandledRejection', (e) => error('unhandled rejection', { error: String(e?.stack ?? e) }));

  writeDataDirPointer();
  publishIdentity();
  server.start();
  telemetry.start();
  await refreshPolicy();
  const loop = async () => {
    await refreshPolicy();
    setTimeout(loop, (policy.policy.refresh_seconds ?? 60) * 1000).unref();
  };
  setTimeout(loop, (policy.policy.refresh_seconds ?? 60) * 1000).unref();
  telemetry.emit('bridge_started', { signed_in: platform.isSignedIn() });
  info('bridge ready', { platform: config.platformUrl, signed_in: platform.isSignedIn() });

  const shutdown = async () => {
    await telemetry.flush().catch(() => {});
    process.exit(0);
  };
  server.onClose = shutdown;
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
