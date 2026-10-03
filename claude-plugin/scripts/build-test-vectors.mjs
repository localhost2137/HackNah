#!/usr/bin/env node
// Writes docs/TEST_VECTORS.md: exact expected outputs for the backend (canonical JSON,
// thumbprints, hashes, a DPoP proof, a response signature, PKCE), computed with the
// plugin's own functions and self-checked with the mock's verifiers.
//
//   npm run test-vectors

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64url, jwkThumbprint, sha256b64url, shortCode, stableStringify } from '../plugin/bridge/util.mjs';
import { verifyJws } from '../mock-backend/dpop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Fixed TEST keys (published on purpose; never use them for anything real)
const DEVICE_JWK = { kty: 'EC', crv: 'P-256', x: 'ZrgXnDoNhTdpPghp2Il6zDXnD03mYf0B5FKrCeFT_HQ', y: 'yaKxBIJVzGvANrVer415sm8NT8HUIb0fRRD6FqoBizE', d: 's8XlTO_ZmbBBhI-gAdYRypKDYuAi1DYzNkaFO2j9Lac' };
const PLATFORM_JWK = { kty: 'EC', crv: 'P-256', x: 'rGpHJgL539MWeSaWJnOghDqOMR1QvZdFypmEb6u9UNY', y: 'CkUanViEc4u6jplQ4dq-C2DrdJvx76u0ykqEVmBKI54', d: 'oUF3ZWAc_NjI9Oex-9n6CBE2SLtAGygPB3KsVm2zK0o' };
const pub = ({ kty, crv, x, y }) => ({ kty, crv, x, y });
const keyOf = (jwk) => createPrivateKey({ key: jwk, format: 'jwk' });

function jws(header, claims, jwk) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), { key: keyOf(jwk), dsaEncoding: 'ieee-p1363' }))}`;
}

const code = (s, lang = '') => `\`\`\`${lang}\n${s}\n\`\`\``;
const sections = [];
const add = (title, body) => sections.push(`## ${title}\n\n${body}`);

// 1. canonical JSON
const canonIn = { b: 2, a: { d: [3, { z: 1, y: 'Kraków' }], c: null }, e: 'x' };
add(
  '1. Canonical JSON (used by every hash below)',
  `Object keys sorted (by UTF-16 code unit, i.e. JavaScript's default sort), no whitespace, arrays keep their order, \`undefined\` members dropped, strings as \`JSON.stringify\` writes them (UTF-8, non-ASCII not escaped). Reference: \`stableStringify\` in the plugin's \`bridge/util.mjs\`.

Input (any key order):
${code(JSON.stringify(canonIn), 'json')}
Canonical:
${code(stableStringify(canonIn))}`,
);

// 2. thumbprint + device code
const jkt = jwkThumbprint(DEVICE_JWK);
add(
  '2. JWK thumbprint (RFC 7638) and device code',
  `Thumbprint = base64url(SHA-256(\`{"crv":…,"kty":…,"x":…,"y":…}\`)), members in exactly that order, no whitespace. The device code is the first 60 bits of the decoded thumbprint as base32 (\`A–Z2–7\`), 12 characters in groups of 4.

Public key (test device key):
${code(JSON.stringify(pub(DEVICE_JWK)), 'json')}
| Value | |
|---|---|
| thumbprint (\`jkt\`, \`dpop_jkt\`, \`cnf.jkt\`) | \`${jkt}\` |
| device code | \`${shortCode(jkt)}\` |`,
);

// 3. hashes
const toolCall = { tool: 'email_send', arguments: { to: 'anna@company.com', subject: 'Hi', body: 'Hello' } };
const toolCallReordered = { arguments: { subject: 'Hi', body: 'Hello', to: 'anna@company.com' }, tool: 'email_send' };
const def = { name: 'crm_search_customers', description: 'Search customers in the CRM by name or city.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const fp = { machine_id_hash: 'xRi8UR5PNZym6zhjGl-1f_9DkdQwbXvrJ_JFg05qssc', hardware_model: 'Mac16,8', cpu_model: 'Apple M4 Pro', cpu_count: 14, memory_gb: 24, os_family: 'darwin', arch: 'arm64' };
const accessToken = 'example-access-token-123';
const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
add(
  '3. Hashes (all base64url SHA-256, no padding)',
  `| Name | Input | Output |
|---|---|---|
| action hash (\`ah\` in the \`hook\` claim; challenge binding) | canonical \`${stableStringify(toolCall)}\` | \`${sha256b64url(stableStringify(toolCall))}\` |
| same, keys in another order | \`${JSON.stringify(toolCallReordered)}\` | \`${sha256b64url(stableStringify(toolCallReordered))}\` (identical) |
| tool definition hash (\`policy.pinned\`) | canonical \`{name, description, inputSchema}\` of \`${JSON.stringify(def)}\` | \`${sha256b64url(stableStringify({ name: def.name, description: def.description, inputSchema: def.inputSchema }))}\` |
| device fingerprint hash (\`dfp\`) | canonical \`${JSON.stringify(fp)}\` | \`${sha256b64url(stableStringify(fp))}\` |
| \`ath\` | access token \`${accessToken}\` | \`${sha256b64url(accessToken)}\` |
| \`bh\` | raw body bytes \`${body}\` | \`${sha256b64url(body)}\` |
| \`bh\` of an empty body (e.g. 304) | \`\` | \`${sha256b64url('')}\` |`,
);

// 4. client context header
const ctx = { client: { name: 'claude-code', version: '2.1.288' }, hostname: 'Mac.local', kernel: '25.6.0', key_storage: 'secure_enclave', node: '26.5.0', bridge: '0.1.0', os_user: 'dev', os_version: 'macOS 26.6.2' };
const ctxJson = stableStringify(ctx);
add(
  '4. HY-Client-Context header and `ctxh`',
  `The header is base64url of the canonical JSON; \`ctxh\` is base64url SHA-256 of the **decoded header bytes** (verify by hashing what you decoded, don't re-serialise).

| | |
|---|---|
| decoded JSON | \`${ctxJson}\` |
| header value | \`${b64url(ctxJson)}\` |
| \`ctxh\` | \`${sha256b64url(ctxJson)}\` |`,
);

// 5. DPoP proof
const htu = 'https://platform.example.com/mcp';
const claims = {
  jti: 'vector-jti-0001',
  htm: 'POST',
  htu,
  iat: 1791040000,
  nonce: 'nonce-abc',
  ath: sha256b64url(accessToken),
  bh: sha256b64url(body),
  dfp: sha256b64url(stableStringify(fp)),
  ctxh: sha256b64url(ctxJson),
  idle: 4,
  osp: { fv: true, sip: true, gk: true, fw: false },
  hook: { sid: 'claude-session-42', eid: 'hook-1', ah: sha256b64url(stableStringify(toolCall)), ts: 1791039999 },
};
const proof = jws({ typ: 'dpop+jwt', alg: 'ES256', jwk: pub(DEVICE_JWK) }, claims, DEVICE_JWK);
const presence = jws({ typ: 'hy-presence+jwt', alg: 'ES256', jwk: pub(PLATFORM_JWK) }, claims, PLATFORM_JWK);
const checked = verifyJws(proof, 'dpop+jwt'); // self-check with the mock's verifier
if (checked.jkt !== jkt) throw new Error('vector self-check failed');
add(
  '5. DPoP proof (request to `POST https://platform.example.com/mcp`)',
  `ES256 signatures are randomised, so a new run produces a different (equally valid) signature. **Test your verifier with this exact proof**: it must accept it (ignoring \`iat\` freshness, the jti cache and the nonce, which are time/state dependent) and derive the thumbprint \`${jkt}\`. Signature encoding is JWS: raw \`r||s\` (64 bytes), **not DER**.

Proof (\`DPoP\` header):
${code(proof)}
Decoded header:
${code(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: pub(DEVICE_JWK) }, null, 2), 'json')}
Decoded claims:
${code(JSON.stringify(claims, null, 2), 'json')}
Must be **rejected**: the same proof with the request body changed (\`bh\` mismatch), sent to another URL (\`htu\`), with method GET (\`htm\`), with a different access token (\`ath\`), a second time within 5 min (\`jti\` replay), or with one character of the signature changed.

Presence proof example: same claims, signed by another key (here the test *platform* key stands in for a Touch ID key), \`typ: hy-presence+jwt\`. Valid only if its key's thumbprint is the device's registered \`presence_jkt\`:
${code(presence)}`,
);

// 6. response signature
const platformKid = jwkThumbprint(PLATFORM_JWK);
const respBody = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
const respClaims = { jti: claims.jti, status: 200, bh: sha256b64url(respBody), iat: 1791040001 };
const respSig = jws({ alg: 'ES256', kid: platformKid, typ: 'hy-response+jwt' }, respClaims, PLATFORM_JWK);
{
  // self-check: verifies against the platform public key, as the bridge does
  const [h, p, sg] = respSig.split('.');
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: pub(PLATFORM_JWK), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url'));
  if (!ok) throw new Error('response signature self-check failed');
}
add(
  '6. Response signature (`HY-Response-Signature`)',
  `The platform signs \`{jti of the request's DPoP proof, status, bh of the raw response body, iat}\` with its response-signing key (published as \`response_signing_jwk\` in discovery, \`kid\` = its thumbprint).

Test platform public key (\`response_signing_jwk\`):
${code(JSON.stringify({ ...pub(PLATFORM_JWK), alg: 'ES256', use: 'sig', kid: platformKid }), 'json')}
Response body \`${respBody}\`, status 200, answering the proof in §5. Header value:
${code(respSig)}
Decoded claims: \`${JSON.stringify(respClaims)}\`. The plugin rejects it if the body, the status, or the jti (another request) differ, if \`iat\` is more than 300 s off, or if the key isn't the pinned one.`,
);

// 7. PKCE
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
add(
  '7. PKCE (RFC 7636, S256)',
  `| | |
|---|---|
| \`code_verifier\` | \`${verifier}\` |
| \`code_challenge\` = base64url(SHA-256(verifier)) | \`${sha256b64url(verifier)}\` |

(This is RFC 7636 Appendix B's example verifier; the challenge must equal \`E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM\`.)`,
);
if (sha256b64url(verifier) !== 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM') throw new Error('PKCE self-check failed');

// ---------- write ----------
const file = join(root, 'docs', 'TEST_VECTORS.md');
writeFileSync(
  file,
  `<!-- Generated by \`npm run test-vectors\` (scripts/build-test-vectors.mjs). Don't edit by hand. -->\n\n# Test vectors\n\nComputed with the plugin's own code and self-checked with the mock's verifiers; cross-checked with Python's standard library and OpenSSL when first written. Use them as unit tests for the backend: your implementation must produce the same outputs byte for byte. Paths are inside \`claude-plugin/\`.\n\n${sections.join('\n\n')}\n`,
);
console.log(`written ${file}`);
