#!/usr/bin/env node
// hy-guard bridge entry point.
//   main.mjs serve   MCP stdio server (started by Claude Code via .mcp.json)
//   main.mjs hook    Claude Code hook handler (hooks/hooks.json)
//   main.mjs login   sign in from a terminal
//   main.mjs status  print device and sign-in state
//   main.mjs pins-reset [tool]  forget pinned tool definitions
//   main.mjs pins-reset --platform  forget the pinned platform signing key
//   main.mjs llm-key   apiKeyHelper: start the local model proxy, print its local key
//   main.mjs llm-proxy local model-API proxy that DPoP-signs every request

import { config } from './config.mjs';

const cmd = process.argv[2] ?? 'serve';

if (cmd === 'hook') {
  // Hooks must never break Claude Code: swallow every error.
  const { runHook } = await import('./hook.mjs');
  await runHook().catch(() => {});
  process.exit(0);
}

if (cmd === 'llm-key') {
  const { runLlmKey } = await import('./llm-proxy.mjs');
  await runLlmKey();
  process.exit(0);
}

const { error } = await import('./log.mjs');
const { loadKeyProvider } = await import('./keys.mjs');
const { PlatformClient } = await import('./platform.mjs');
const { shortCode, readJson, writeJson } = await import('./util.mjs');

if (cmd === 'pins-reset' && process.argv[3] === '--platform') {
  const pins = readJson(config.paths.platformKeyPin, {});
  delete pins[config.platformUrl];
  writeJson(config.paths.platformKeyPin, pins);
  console.log(`platform signing key pin removed for ${config.platformUrl}; the next connection pins the current key`);
  process.exit(0);
}

if (cmd === 'pins-reset') {
  const pins = readJson(config.paths.pins, {});
  const tool = process.argv[3];
  if (tool) delete pins[config.platformUrl]?.[tool];
  else delete pins[config.platformUrl];
  writeJson(config.paths.pins, pins);
  console.log(tool ? `pin removed for ${tool}` : 'all pins removed');
  process.exit(0);
}

const keys = await loadKeyProvider();
const platform = new PlatformClient(keys);

if (cmd === 'login') {
  console.log(`Device code: ${shortCode(keys.thumbprint)} (compare it with the browser page)`);
  const t = await platform.login();
  console.log(`Signed in as ${t.user?.email}`);
  process.exit(0);
}

if (cmd === 'llm-proxy') {
  const { runLlmProxy } = await import('./llm-proxy.mjs');
  await runLlmProxy(platform).catch((e) => {
    error('llm proxy could not start', { error: e.message });
    process.exit(1);
  });
} else if (cmd === 'status') {
  const t = platform.tokens;
  console.log(
    JSON.stringify(
      {
        platform: config.platformUrl,
        signed_in: Boolean(t),
        user: t?.user ?? null,
        key_storage: keys.storage,
        presence_key: keys.hasPresence(),
        device_code: shortCode(keys.thumbprint),
        jkt: keys.thumbprint,
        data_dir: config.dataDir,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (cmd === 'serve') {
  const { serve } = await import('./serve.mjs');
  await serve(keys, platform);
} else if (cmd !== 'llm-proxy') {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
