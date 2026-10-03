// HTML for the mock's browser pages: SSO + device approval, action approval, dashboard.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Buttons in forms marked data-js are sent with fetch instead of navigating, so the tab
// keeps a single history entry and may close itself at the end (browser rule for
// window.close() on tabs not opened by a script). Without JS the forms still work.
const AUTO_CLOSE_SCRIPT = `<script>
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('form[data-js]')) return;
  e.preventDefault();
  const body = new URLSearchParams(new FormData(f, e.submitter));
  const res = await fetch(f.action, { method: 'POST', body, headers: { Accept: 'application/json' } });
  const out = await res.json().catch(() => ({}));
  if (out.redirect) return location.replace(out.redirect);   // sign-in: continue to Claude Code
  const box = document.getElementById('result');
  if (!res.ok) { box.innerHTML = '<p class="deny"><b></b></p>'; box.querySelector('b').textContent = out.error ?? 'Failed'; return; }
  document.querySelectorAll('form[data-js]').forEach((x) => x.remove());
  const ok = out.status === 'approved';
  box.innerHTML = '<p style="font-size:18px"><b class="' + (ok ? 'allow' : 'deny') + '">' + (ok ? 'Approved ✓' : 'Denied') +
    '</b></p><p class="muted" id="closing">Back to Claude Code. This tab closes automatically…</p>';
  setTimeout(() => { window.close(); setTimeout(() => (document.getElementById('closing').textContent = 'You can close this tab.'), 300); }, 1200);
});
</script>`;

export const layout = (title, body, refresh) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title>
${AUTO_CLOSE_SCRIPT}
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171c;--muted:#5d6672;--line:#dde1e6;--accent:#2457d6;--ok:#1a7f43;--warn:#a15c00;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaee;--muted:#9aa3ae;--line:#2a2f37;--accent:#6c95ff;--ok:#3ccb7f;--warn:#f0a43a;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:0 0 10px}
.muted{color:var(--muted)}.code{font:600 22px ui-monospace,monospace;letter-spacing:2px}
button,input{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
.allow{color:var(--ok)}.challenge{color:var(--warn)}.deny{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap}.wrap{overflow-x:auto}
</style></head><body><main>${body}</main></body></html>`;

// One-click demo accounts. No password: this page stands in for the company SSO
// (Okta, Entra ID, Google), which the real backend redirects to instead.
export const DEMO_USERS = ['dev@company.com', 'admin@company.com', 'intern@company.com'];

export function authorizePage(req) {
  return layout(
    'Sign in',
    `<div class="card"><h1>Sign in to company tools</h1>
<p class="muted">Mock SSO: pick an account, no password. The real platform sends you to your identity provider here.</p>
<form method="post" action="/authorize/decision" data-js>
<input type="hidden" name="request_id" value="${esc(req.id)}">
<h2>New device</h2>
<p>Device: <b>${esc(req.device_name)}</b> (${esc(req.platform)})<br>
Key storage: <b>${esc(req.key_storage)}</b></p>
<p>Device code (must match Claude Code):<br><span class="code">${esc(req.short_code)}</span></p>
<p class="muted">Logging in approves this device.</p>
<div class="row">${DEMO_USERS.map(
      (u, i) =>
        `<button ${i === 0 ? 'class="primary" ' : ''}name="email" value="${esc(u)}">Log in as ${esc(u)}</button>`,
    ).join('')}</div>
<p><button name="decision" value="deny">Cancel</button></p>
</form></div>`,
  );
}

export function challengePage(c, error) {
  const done = c.status !== 'pending';
  const row = (k, v) => (v === undefined || v === null || v === '' ? '' : `<tr><th>${esc(k)}</th><td>${v}</td></tr>`);
  const args = Object.entries(c.arguments ?? {})
    .map(([k, v]) => `<code>${esc(k)}</code>: ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('<br>');
  const where = c.geo ? `${esc(c.ip)} (${esc(c.geo.city)}, ${esc(c.geo.country)})` : esc(c.ip);
  return layout(
    'Approve action',
    `<div class="card"><h1>Approve this action?</h1>
<p style="font-size:18px"><b>${esc(c.description ?? c.tool)}</b></p>
<table>
${row('Tool', `<code>${esc(c.tool)}</code> <span class="muted">(${esc(c.tier ?? '')})</span>`)}
${row('Arguments', args || '<span class="muted">none</span>')}
${row('Requested by', `Claude Code on <b>${esc(c.device_name)}</b> <span class="muted">${esc(c.key_storage ?? '')}</span>`)}
${row('Device code', c.device_code ? `<span class="code" style="font-size:16px">${esc(c.device_code)}</span>` : '')}
${row('Claude Code session', c.claude_session_id ? `<code>${esc(c.claude_session_id)}</code>` : '')}
${row('Network', where)}
${row('Device health', c.posture_score !== null && c.posture_score !== undefined ? `CrowdStrike ${esc(c.posture_score)}/100` : '')}
${row('Requested at', esc(c.created_at?.replace('T', ' ').slice(0, 19)) + ' UTC')}
${row('Why approval is needed', c.reasons.map(esc).join('<br>'))}
</table>
${error ? `<p class="deny"><b>${esc(error)}</b></p>` : ''}
${
  done
    ? `<p>Status: <b class="${c.status === 'approved' ? 'allow' : 'deny'}">${esc(c.status)}</b>${c.approved_by ? ` by ${esc(c.approved_by)}` : ''}. You can close this tab.</p>`
    : `<p class="muted">Didn't start this in Claude Code, or the device code doesn't match yours? <b>Deny</b> it and tell your security team.</p>
<h2>Confirm it's you</h2>
<p class="muted">Mock SSO: approving needs a fresh sign-in as the device's owner. The real platform sends you to your identity provider here, with no remembered session.</p>
<div id="result"></div>
<form method="post" action="/challenge/${esc(c.id)}/approve" class="row" data-js>${DEMO_USERS.map(
        (u, i) => `<button ${i === 0 ? 'class="primary" ' : ''}name="email" value="${esc(u)}">Sign in as ${esc(u)} and approve</button>`,
      ).join('')}</form>
<form method="post" action="/challenge/${esc(c.id)}/deny" data-js><p><button class="danger">Deny</button></p></form>`
}</div>`,
  );
}

export function dashboardPage(db) {
  const users = db.users;
  const devices = Object.values(db.devices);
  const decisions = db.decisions.slice(-30).reverse();
  const events = db.events.slice(-40).reverse();
  return layout(
    'Gateway dashboard',
    `<h1>Gateway dashboard (mock)</h1>
<p class="muted"><a href="/mock-falcon/console">Mock CrowdStrike console →</a></p>
<div class="card"><h2>Devices</h2><div class="wrap"><table><tr><th>Device</th><th>User</th><th>Key</th><th>Code</th><th>Networks</th><th>Status</th><th></th></tr>
${devices
  .map(
    (d) => `<tr><td>${esc(d.name)}<br><span class="muted">${esc(
      [d.fingerprint?.details?.hardware_model, d.context?.os_version, d.context?.client && `${d.context.client.name} ${d.context.client.version}`]
        .filter(Boolean)
        .join(' · ') || d.platform,
    )}</span></td><td>${esc(users[d.user_id]?.email)}</td>
<td>${esc(d.key_storage)}${d.presence_jkt ? ' + Touch ID' : ''}${posture(d.posture)}</td><td><code>${esc(d.short_code)}</code></td>
<td>${d.ips.map((i) => esc(i.ip)).join('<br>')}</td><td>${d.revoked_at ? '<b class="deny">revoked</b>' : '<span class="allow">active</span>'}${d.fingerprint_mismatch_at ? `<br><b class="deny">⚠ key seen on another machine</b>` : ''}${d.theft_suspected_at ? `<br><b class="deny">⚠ token theft suspected</b><br><span class="muted">${esc(d.theft_suspected_at.slice(11, 19))}</span>` : ''}</td>
<td>${d.revoked_at ? '' : `<div class="row"><form method="post" action="/admin/devices/${esc(d.id)}/lock"><button title="Next refresh needs Touch ID">Lock session</button></form><form method="post" action="/admin/devices/${esc(d.id)}/revoke"><button class="danger">Revoke</button></form></div>`}</td></tr>`,
  )
  .join('')}</table></div></div>
${
  db.rejections.length
    ? `<div class="card"><h2>Rejected credentials</h2><div class="wrap"><table><tr><th>Time</th><th>From IP</th><th>Endpoint</th><th>Reason</th><th>Token belongs to</th><th>Key presented</th></tr>
${db.rejections
  .slice(-20)
  .reverse()
  .map((r) => {
    const v = r.victim_device_id ? db.devices[r.victim_device_id] : null;
    return `<tr><td>${esc(r.ts.slice(11, 19))}</td><td>${esc(r.ip)}</td><td>${esc(r.path)}</td>
<td class="${r.theft_suspected ? 'deny' : ''}">${r.theft_suspected ? '<b>stolen token</b>: ' : ''}${esc(r.reason)}</td>
<td>${v ? `${esc(v.name)} <code>${esc(v.short_code)}</code><br><span class="muted">${esc(users[v.user_id]?.email)}</span>` : '<span class="muted">unknown token</span>'}</td>
<td>${r.presented_key ? `<code>${esc(r.presented_key)}</code>` : '<span class="muted">none</span>'}</td></tr>`;
  })
  .join('')}</table></div></div>`
    : ''
}
<div class="card"><h2>Decisions</h2><div class="wrap"><table><tr><th>Time</th><th>Tool</th><th>Decision</th><th>Reasons</th><th>Signals</th></tr>
${decisions
  .map(
    (x) => `<tr><td>${esc(x.ts.slice(11, 19))}</td><td>${esc(x.tool)}</td><td class="${esc(x.decision)}"><b>${esc(x.decision)}</b></td>
<td>${x.reasons.map(esc).join('<br>')}</td><td class="muted">${esc(`tier=${x.signals.tier} ip=${x.signals.ip} presence=${x.signals.presence_verified} hook=${x.signals.hook_correlated ?? '-'} idle=${x.signals.user_idle_minutes ?? '-'}m zta=${x.signals.posture_score ?? x.signals.posture_status ?? '-'}${x.signals.posture_status === 'compromised' ? ' COMPROMISED' : ''}`)}</td></tr>`,
  )
  .join('')}</table></div></div>
<div class="card"><h2>Events</h2><div class="wrap"><table><tr><th>Time</th><th>Source</th><th>Type</th><th>Data</th></tr>
${events
  .map(
    (e) => `<tr><td>${esc(e.ts?.slice(11, 19))}</td><td>${esc(e.source)}</td><td>${esc(e.type)}</td><td class="muted"><code>${esc(JSON.stringify(e.data).slice(0, 220))}</code></td></tr>`,
  )
  .join('')}</table></div></div>`,
    3,
  );
}
