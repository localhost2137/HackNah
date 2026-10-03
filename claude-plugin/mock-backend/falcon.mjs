// Mock CrowdStrike Falcon cloud + the platform's Falcon client.
//
// Mock API (same paths and envelope as the real Falcon API, mounted under /mock-falcon):
//   POST /oauth2/token                                   client credentials -> bearer token
//   GET  /zero-trust-assessment/entities/assessments/v1  ?ids=<aid>  -> resources[].assessment
//   GET  /devices/entities/devices/v2                    ?ids=<aid>  -> resources[].status
// Console (mock only): /mock-falcon/console -- change a host's score, contain it, or raise a
// detection, which pushes a CAEP "device-compliance-change" event to the platform.
//
// Platform client: falconPosture(aid) asks FALCON_BASE_URL (mock by default; real:
// https://api.crowdstrike.com or api.eu-1...) with FALCON_CLIENT_ID / FALCON_CLIENT_SECRET.

import { randomBytes, randomUUID } from 'node:crypto';
import { db, save } from './store.mjs';

const MOCK_CLIENT_ID = 'mock-falcon-client';
const MOCK_CLIENT_SECRET = 'mock-falcon-secret';
const CACHE_MS = Number(process.env.FALCON_CACHE_S ?? 10) * 1000;

const falcon = () => (db.falcon ??= { hosts: {}, tokens: {} });

// ---------------- mock Falcon cloud ----------------

const envelope = (resources, errors = []) => ({
  meta: { query_time: 0.001, powered_by: 'mock-falcon', trace_id: randomUUID() },
  resources,
  errors,
});

/** The sensor reports to the cloud: create the host the first time we hear of it. */
export function seedFalconHost(aid, cid, score) {
  const f = falcon();
  if (f.hosts[aid]) return;
  f.hosts[aid] = {
    aid,
    cid,
    score,
    status: 'normal',
    hostname: null,
    modified_time: new Date().toISOString(),
  };
  save();
}

/** Handle /mock-falcon/* API routes. Returns true when handled. */
export async function mockFalconApi(req, res, url, path, { send, readBody }) {
  const p = path.slice('/mock-falcon'.length);
  if (p === '/oauth2/token' && req.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams((await readBody(req)).toString()));
    if (f.client_id !== MOCK_CLIENT_ID || f.client_secret !== MOCK_CLIENT_SECRET)
      return send(res, 401, envelope([], [{ code: 401, message: 'access denied, invalid client' }])), true;
    const token = randomBytes(24).toString('hex');
    falcon().tokens[token] = Date.now() + 1799_000;
    return send(res, 201, { access_token: token, token_type: 'bearer', expires_in: 1799 }), true;
  }
  if (!p.startsWith('/zero-trust-assessment/') && !p.startsWith('/devices/')) return false;

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
  if (!(falcon().tokens[bearer] > Date.now())) return send(res, 401, envelope([], [{ code: 401, message: 'access denied, authorization failed' }])), true;
  const ids = url.searchParams.getAll('ids').flatMap((v) => v.split(','));
  const hosts = ids.map((id) => falcon().hosts[id]).filter(Boolean);

  if (p === '/zero-trust-assessment/entities/assessments/v1' && req.method === 'GET') {
    return (
      send(
        res,
        200,
        envelope(
          hosts.map((h) => ({
            aid: h.aid,
            cid: h.cid,
            assessment: { overall: h.score, os: Math.min(100, h.score + 5), sensor_config: h.score, version: 'mock-1' },
            assessment_items: { os_signals: [], sensor_signals: [] },
            modified_time: h.modified_time,
            event_platform: 'Mac',
            product_type_desc: 'Workstation',
            sensor_file_status: 'not deployed',
            system_serial_number: null,
          })),
        ),
      ),
      true
    );
  }
  if (p === '/devices/entities/devices/v2' && req.method === 'GET') {
    return (
      send(
        res,
        200,
        envelope(hosts.map((h) => ({ device_id: h.aid, cid: h.cid, hostname: h.hostname, status: h.status, platform_name: 'Mac' }))),
      ),
      true
    );
  }
  return false;
}

// ---------------- platform side: Falcon client ----------------

const FALCON_BASE = () => (process.env.FALCON_BASE_URL ?? '').replace(/\/+$/, '');
let tokenCache = { token: null, exp: 0 };
const postureCache = new Map(); // aid -> { at, value }

async function falconToken(base) {
  if (tokenCache.token && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.FALCON_CLIENT_ID ?? MOCK_CLIENT_ID,
      client_secret: process.env.FALCON_CLIENT_SECRET ?? MOCK_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`falcon oauth2: HTTP ${res.status}`);
  const t = await res.json();
  tokenCache = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}

/**
 * Server-to-server posture for one agent ID: { score, contained } or throws.
 * Cached for FALCON_CACHE_S (10 s), so a change in the console lands within seconds.
 */
export async function falconPosture(defaultBase, aid) {
  const base = FALCON_BASE() || defaultBase;
  const hit = postureCache.get(aid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const token = await falconToken(base);
  const get = async (path) => {
    const res = await fetch(`${base}${path}?ids=${encodeURIComponent(aid)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`falcon ${path}: HTTP ${res.status}`);
    return (await res.json()).resources?.[0] ?? null;
  };
  const [zta, host] = await Promise.all([
    get('/zero-trust-assessment/entities/assessments/v1'),
    get('/devices/entities/devices/v2'),
  ]);
  const value = {
    known: Boolean(zta || host),
    score: zta?.assessment?.overall ?? null,
    contained: host?.status === 'contained' || host?.status === 'containment_pending',
  };
  postureCache.set(aid, { at: Date.now(), value });
  return value;
}

export const forgetFalconPosture = (aid) => postureCache.delete(aid);

// ---------------- mock console ----------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function consolePage(layout) {
  const hosts = Object.values(falcon().hosts);
  return layout(
    'Mock CrowdStrike console',
    `<h1>Mock CrowdStrike Falcon console</h1>
<p class="muted">Stands in for the Falcon cloud. The platform reads this through the real Falcon API paths
(<code>/zero-trust-assessment/entities/assessments/v1</code>, <code>/devices/entities/devices/v2</code>). <a href="/">← gateway dashboard</a></p>
<div class="card"><h2>Hosts</h2><div class="wrap"><table><tr><th>Agent ID</th><th>ZTA score</th><th>Status</th><th>Actions</th></tr>
${
  hosts
    .map(
      (h) => `<tr><td><code>${esc(h.aid)}</code></td>
<td><form method="post" action="/mock-falcon/console/hosts/${esc(h.aid)}/score" class="row">
<input name="score" type="number" min="0" max="100" value="${esc(h.score)}" style="width:5em"><button>Set</button></form></td>
<td>${h.status === 'contained' ? '<b class="deny">contained</b>' : '<span class="allow">normal</span>'}${h.detection ? `<br><b class="deny">⚠ ${esc(h.detection)}</b>` : ''}</td>
<td><div class="row">
<form method="post" action="/mock-falcon/console/hosts/${esc(h.aid)}/${h.status === 'contained' ? 'lift' : 'contain'}"><button>${h.status === 'contained' ? 'Lift containment' : 'Contain host'}</button></form>
<form method="post" action="/mock-falcon/console/hosts/${esc(h.aid)}/${h.detection ? 'resolve' : 'detect'}"><button class="${h.detection ? '' : 'danger'}">${h.detection ? 'Resolve detection' : 'Raise detection'}</button></form>
</div></td></tr>`,
    )
    .join('') || '<tr><td colspan="4" class="muted">No hosts yet. They appear when a device sends its ZTA token (npm run zta -- 90).</td></tr>'
}</table></div></div>`,
    3,
  );
}

/**
 * Console actions. Detections are pushed to the platform as a CAEP
 * "device-compliance-change" event, over HTTP, exactly like an external EDR would.
 */
export async function consoleAction(req, res, path, { redirect, publicUrl, caepSecret }) {
  const m = path.match(/^\/mock-falcon\/console\/hosts\/([\w-]+)\/(score|contain|lift|detect|resolve)$/);
  if (!m || req.method !== 'POST') return false;
  const h = falcon().hosts[m[1]];
  if (!h) return redirect(res, '/mock-falcon/console'), true;
  if (m[2] === 'score') {
    let body = '';
    for await (const c of req) body += c;
    const score = Number(new URLSearchParams(body).get('score'));
    if (Number.isInteger(score) && score >= 0 && score <= 100) h.score = score;
  }
  if (m[2] === 'contain') h.status = 'contained';
  if (m[2] === 'lift') h.status = 'normal';
  if (m[2] === 'detect' || m[2] === 'resolve') {
    const compliant = m[2] === 'resolve';
    h.detection = compliant ? null : 'Malware detected: credential theft (mock)';
    await fetch(`${publicUrl}/v1/signals/caep`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${caepSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(caepEvent(h.aid, compliant, h.detection)),
    }).catch(() => {});
  }
  h.modified_time = new Date().toISOString();
  forgetFalconPosture(h.aid);
  save();
  return redirect(res, '/mock-falcon/console'), true;
}

/** CAEP device-compliance-change (OpenID Shared Signals). Real ones arrive as signed SETs. */
export function caepEvent(aid, compliant, reason) {
  return {
    iss: 'https://mock-falcon.local',
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    events: {
      'https://schemas.openid.net/secevent/caep/event-type/device-compliance-change': {
        subject: { format: 'opaque', id: aid },
        current_status: compliant ? 'compliant' : 'not-compliant',
        previous_status: compliant ? 'not-compliant' : 'compliant',
        reason_admin: { en: reason ?? 'detection resolved' },
        event_timestamp: Math.floor(Date.now() / 1000),
      },
    },
  };
}
