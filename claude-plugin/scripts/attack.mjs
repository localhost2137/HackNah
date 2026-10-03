#!/usr/bin/env node
// Demo attacker: has stolen tokens.json (e.g. via an infostealer) but not the device key.
// Usage: node scripts/attack.mjs [platform_url] [tokens.json]
//   tokens.json lives in the plugin data dir (see `node plugin/bridge/main.mjs status`).
// With MOCK_TRUST_IP_HEADER=1 on the mock, requests appear to come from Singapore.

import { createPublicKey, generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b64 = (b) => Buffer.from(b).toString('base64url');

function attackerProof(key, jwk, method, url, nonce, accessToken, body) {
  const claims = { jti: randomUUID(), htm: method, htu: url, iat: Math.floor(Date.now() / 1000), nonce };
  if (accessToken) claims.ath = b64(createHash('sha256').update(accessToken).digest());
  if (body) claims.bh = b64(createHash('sha256').update(body).digest());
  const input = `${b64(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk }))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${b64(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

/** Use a stolen access (or refresh) token with a freshly generated attacker key. */
export async function attackWithOwnKey(base, stolenToken, ip, mode = 'access') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = createPublicKey(privateKey).export({ format: 'jwk' });
  const jwk = { kty, crv, x, y };
  const nonce = (await fetch(`${base}/.well-known/hy-platform`)).headers.get('dpop-nonce');

  if (mode === 'refresh') {
    const url = `${base}/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { DPoP: attackerProof(privateKey, jwk, 'POST', url, nonce), 'Content-Type': 'application/x-www-form-urlencoded', 'X-Mock-Client-IP': ip },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stolenToken, client_id: 'hy-cc-plugin' }),
    });
    return { status: res.status, body: await res.text() };
  }
  const url = `${base}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `DPoP ${stolenToken}`,
      DPoP: attackerProof(privateKey, jwk, 'POST', url, nonce, stolenToken, body),
      'Content-Type': 'application/json',
      'X-Mock-Client-IP': ip,
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? 'http://127.0.0.1:8787';
  const file = process.argv[3];
  if (!file) {
    console.error('usage: node scripts/attack.mjs <platform_url> <path/to/tokens.json>');
    process.exit(2);
  }
  const stolen = JSON.parse(readFileSync(file, 'utf8'));
  console.log('1) stolen access token as plain Bearer');
  const r1 = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${stolen.access_token}`, 'Content-Type': 'application/json', 'X-Mock-Client-IP': '203.0.113.7' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  });
  console.log(`   -> HTTP ${r1.status} ${await r1.text()}`);
  console.log('2) stolen access token + attacker-generated DPoP key');
  const r2 = await attackWithOwnKey(base, stolen.access_token, '203.0.113.7');
  console.log(`   -> HTTP ${r2.status} ${r2.body}`);
  console.log('3) stolen refresh token + attacker key');
  const r3 = await attackWithOwnKey(base, stolen.refresh_token, '203.0.113.7', 'refresh');
  console.log(`   -> HTTP ${r3.status} ${r3.body}`);
}
