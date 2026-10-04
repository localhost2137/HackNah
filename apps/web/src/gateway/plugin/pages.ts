// The two browser pages of the plugin protocol: approving a device at sign-in, and approving one
// action. Plain HTML from the gateway, so they work before the dashboard app has loaded and can
// be posted with or without JavaScript.

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

/**
 * Forms marked `data-js` are sent with fetch, so the tab keeps one history entry and may close
 * itself at the end. Without JavaScript the same forms post and redirect.
 */
const SCRIPT = `<script>
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('form[data-js]')) return;
  e.preventDefault();
  const body = new URLSearchParams(new FormData(f, e.submitter));
  const res = await fetch(f.action, { method: 'POST', body, headers: { Accept: 'application/json' } });
  const out = await res.json().catch(() => ({}));
  if (out.redirect) return location.replace(out.redirect);
  const box = document.getElementById('result');
  if (!res.ok) { box.innerHTML = '<p class="bad"><b></b></p>'; box.querySelector('b').textContent = out.error || 'Failed'; return; }
  document.querySelectorAll('form[data-js], .hint').forEach((x) => x.remove());
  const ok = out.status === 'approved';
  box.innerHTML = '<p class="big"><b class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'Approved' : out.status === 'denied' ? 'Denied' : 'Expired') +
    '</b></p><p class="muted" id="closing">Back to Claude Code. This tab closes automatically…</p>';
  setTimeout(() => { window.close(); setTimeout(() => (document.getElementById('closing').textContent = 'You can close this tab.'), 300); }, 1200);
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-reauth]');
  if (!b) return;
  e.preventDefault();
  // A remembered session must not approve: end it, then sign in again.
  await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  location.assign(b.getAttribute('href'));
});
</script>`

const STYLE = `<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171c;--muted:#5d6672;--line:#dde1e6;--accent:#2457d6;--ok:#1a7f43;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaee;--muted:#9aa3ae;--line:#2a2f37;--accent:#6c95ff;--ok:#3ccb7f;--bad:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
.brand{font-size:13px;color:var(--muted);margin:0 0 8px}
h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:20px 0 8px}
.muted{color:var(--muted)}.big{font-size:18px}
.code{font:600 22px ui-monospace,monospace;letter-spacing:2px}
code{font:13px ui-monospace,monospace;overflow-wrap:anywhere}
button,a.button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--accent)!important;border-color:var(--accent)!important;color:#fff!important}
.danger{color:var(--bad)!important}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px 6px 0;border-top:1px solid var(--line);vertical-align:top}th{width:34%;font-weight:500;color:var(--muted)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
</style>`

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Hack?Nah!</title>${STYLE}${SCRIPT}</head>
<body><main><div class="card"><p class="brand">Hack?Nah!</p>${body}</div></main></body></html>`
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`)
}

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')

export function authorizePage(view: {
  email: string
  deviceName: string
  platform: string
  keyStorage: string
  shortCode: string
  /** The authorization request and the CSRF token, posted back with the decision. */
  fields: Record<string, string>
}): string {
  return layout(
    'Connect this device',
    `<h1>Connect Claude Code on this device?</h1>
<p class="muted">Signed in as <b>${esc(view.email)}</b>. Approving lets Claude Code on this device use company tools and models as you.</p>
<table>
<tr><th>Device</th><td><b>${esc(view.deviceName)}</b> <span class="muted">${esc(view.platform)}</span></td></tr>
<tr><th>Key storage</th><td>${esc(view.keyStorage)}</td></tr>
<tr><th>Device code</th><td><span class="code">${esc(view.shortCode)}</span><br><span class="muted">Must match the code Claude Code shows.</span></td></tr>
</table>
<p class="muted hint">Only approve if you started this sign-in yourself, just now, and the codes match.</p>
<div id="result"></div>
<form method="post" action="/authorize/decision" class="row" data-js>${hidden(view.fields)}
<button class="primary" name="decision" value="approve">Approve this device</button>
<button name="decision" value="deny">Cancel</button>
</form>`,
  )
}

export type ChallengeView = {
  id: string
  tool: string
  description: string | null
  tier: string | null
  arguments: unknown
  reasons: string[]
  deviceName: string | null
  deviceCode: string | null
  keyStorage: string | null
  claudeSessionId: string | null
  ip: string | null
  country: string | null
  postureScore: number | null
  createdAt: Date
  status: 'pending' | 'approved' | 'denied' | 'expired'
  approvedBy: string | null
}

/**
 * Who is looking at a pending challenge. Only `owner` gets the approve button: the device's own
 * user, in a session that started after the challenge was issued.
 */
export type ChallengeViewer =
  | { state: 'anonymous' }
  | { state: 'stale'; email: string }
  | { state: 'other'; email: string }
  | { state: 'owner'; email: string; csrf: string }

export function challengePage(c: ChallengeView, viewer: ChallengeViewer, error?: string): string {
  const row = (k: string, v: string | null) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '')
  const args =
    c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments)
      ? Object.entries(c.arguments as Record<string, unknown>)
          .map(
            ([k, v]) =>
              `<code>${esc(k)}</code>: ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`,
          )
          .join('<br>')
      : esc(JSON.stringify(c.arguments ?? {}))
  const signIn = `/login?redirect=${encodeURIComponent(`/challenge/${c.id}`)}`
  const reauth = (label: string) =>
    `<div class="row"><a class="button primary" data-reauth href="${esc(signIn)}">${esc(label)}</a></div>
<noscript><p class="muted">Sign out of the dashboard first, then sign in again and reopen this page.</p></noscript>`
  const deny = `<form method="post" action="/challenge/${esc(c.id)}/deny" class="row" data-js><button class="danger">Deny</button></form>`

  let action: string
  if (c.status !== 'pending') {
    const label =
      c.status === 'approved' ? 'Approved' : c.status === 'denied' ? 'Denied' : 'Expired'
    action = `<p class="big"><b class="${c.status === 'approved' ? 'ok' : 'bad'}">${label}</b>${c.approvedBy ? ` by ${esc(c.approvedBy)}` : ''}</p><p class="muted">You can close this tab.</p>`
  } else if (viewer.state === 'owner') {
    action = `<h2>Confirm it's you</h2>
<p class="muted hint">You just signed in as <b>${esc(viewer.email)}</b>.</p>
<form method="post" action="/challenge/${esc(c.id)}/approve" class="row" data-js>${hidden({ csrf: viewer.csrf })}<button class="primary">Approve</button></form>${deny}`
  } else {
    const why =
      viewer.state === 'anonymous'
        ? 'Approving needs a fresh sign-in as the owner of this device.'
        : viewer.state === 'stale'
          ? `You are signed in as ${esc(viewer.email)}, but a remembered session cannot approve. Sign in again to confirm it is you.`
          : `You are signed in as ${esc(viewer.email)}, but this device belongs to another account. Only its owner can approve.`
    action = `<h2>Confirm it's you</h2><p class="muted hint">${why}</p>${
      viewer.state === 'anonymous'
        ? `<div class="row"><a class="button primary" href="${esc(signIn)}">Sign in to approve</a></div>`
        : reauth(viewer.state === 'stale' ? 'Sign in again to approve' : 'Sign in as the owner')
    }${deny}`
  }

  return layout(
    'Approve action',
    `<h1>Approve this action?</h1>
<p class="big"><b>${esc(c.description ?? c.tool)}</b></p>
<table>
${row('Tool', `<code>${esc(c.tool)}</code>${c.tier ? ` <span class="muted">(${esc(c.tier)})</span>` : ''}`)}
${row('Arguments', args || '<span class="muted">none</span>')}
${row('Requested by', `Claude Code on <b>${esc(c.deviceName ?? 'unknown device')}</b>${c.keyStorage ? ` <span class="muted">${esc(c.keyStorage)}</span>` : ''}`)}
${row('Device code', c.deviceCode ? `<span class="code" style="font-size:16px">${esc(c.deviceCode)}</span>` : null)}
${row('Claude Code session', c.claudeSessionId ? `<code>${esc(c.claudeSessionId)}</code>` : null)}
${row('Network', c.ip ? `${esc(c.ip)}${c.country ? ` (${esc(c.country)})` : ''}` : null)}
${row('Device health', c.postureScore != null ? `EDR score ${esc(c.postureScore)}/100` : null)}
${row('Requested at', `${esc(c.createdAt.toISOString().replace('T', ' ').slice(0, 19))} UTC`)}
${row('Why approval is needed', c.reasons.map(esc).join('<br>') || null)}
</table>
${c.status === 'pending' ? `<p class="muted hint">Didn't start this in Claude Code, or the device code isn't yours? <b>Deny</b> it and tell your security team.</p>` : ''}
${error ? `<p class="bad"><b>${esc(error)}</b></p>` : ''}
<div id="result"></div>
${action}`,
  )
}
