#!/usr/bin/env node
// Write a mock CrowdStrike Zero Trust Assessment file (data.zta), signed with the mock
// platform's "CrowdStrike" key, so posture can be demoed without a Falcon sensor.
//
//   npm run zta -- 90            healthy laptop
//   npm run zta -- 35            posture drops: write/destructive tools are denied
//   npm run zta -- 10            below the floor: everything (incl. model requests) denied
//   npm run zta -- --clear       remove the file (no posture)
//   npm run zta -- 90 --aid other-host   token from another host (agent ID mismatch)
//
// Path: $HY_ZTA_FILE or /tmp/hy-zta/data.zta (scripts/dev-claude.sh uses the same default).
// The payload shape (aid, cid, assessment.overall/os/sensor_config) follows CrowdStrike's
// ZTA; extra claims of real tokens aren't publicly documented.

import { sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_CID, mockCrowdStrikeKey } from '../mock-backend/posture.mjs';

const args = process.argv.slice(2);
const file = process.env.HY_ZTA_FILE || '/tmp/hy-zta/data.zta';
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--clear')) {
  rmSync(file, { force: true });
  console.log(`removed ${file}`);
  process.exit(0);
}

const score = Number(args.find((a) => /^\d+$/.test(a)));
if (!Number.isInteger(score) || score < 0 || score > 100) {
  console.error('usage: npm run zta -- <score 0-100> [--aid <agent id>] [--cid <tenant>] | --clear');
  process.exit(2);
}

// A stable agent ID for "this laptop", like the Falcon sensor's AID.
const aidFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'mock-backend', '.data', 'mock-aid');
if (!existsSync(aidFile)) {
  mkdirSync(dirname(aidFile), { recursive: true });
  writeFileSync(aidFile, crypto.randomUUID().replaceAll('-', ''));
}
const aid = opt('--aid') ?? readFileSync(aidFile, 'utf8').trim();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', typ: 'JWT' };
const payload = {
  aid,
  cid: opt('--cid') ?? MOCK_CID,
  iat: now,
  exp: now + 7 * 24 * 3600,
  assessment: { overall: score, os: Math.min(100, score + 5), sensor_config: score, version: 'mock-1' },
  assessment_items: { os_signals: [], sensor_signals: [] },
};
const input = `${b64(header)}.${b64(payload)}`;
const sig = sign('sha256', Buffer.from(input), { key: mockCrowdStrikeKey(), dsaEncoding: 'ieee-p1363' }).toString('base64url');

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${input}.${sig}`);
console.log(`wrote ${file}: ZTA overall=${score}, aid=${aid}`);
