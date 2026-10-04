#!/usr/bin/env node
// Headless stand-in for the user's browser against the REAL backend (apps/web), where the
// pages need the dashboard's sign-in. Used by scripts/e2e-backend.mjs as HY_BROWSER_CMD.
//   /authorize?...   sign in, approve the device, follow the redirect to the bridge's loopback
//   /challenge/<id>  sign in again (a fresh session), approve the action
// env: HY_E2E_EMAIL, HY_E2E_PASSWORD   the dashboard account
//      HY_E2E_DECISION=deny            deny instead of approving
//      HY_E2E_URL_FILE=<file>          only write the URL there and leave the page alone
//      HY_E2E_BROWSER_LOG=<file>       append what happened (debugging)

import { appendFileSync, writeFileSync } from 'node:fs';

const target = new URL(process.argv[2] ?? 'http://localhost');
const base = target.origin;
const log = (...a) => process.env.HY_E2E_BROWSER_LOG && appendFileSync(process.env.HY_E2E_BROWSER_LOG, `${a.join(' ')}\n`);

/** Sign in to the dashboard (Better Auth, email + password). Returns the Cookie header. */
export async function signIn(origin, email, password) {
  const res = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: HTTP ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Hidden inputs of the first form posting to `action`. */
export function hiddenFields(html, action) {
  const form = new RegExp(`<form[^>]*action="${action.replace(/[/.]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</form>`).exec(html)?.[1] ?? '';
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)].map((m) => [unescape(m[1]), unescape(m[2])]));
}

export const post = (origin, path, cookie, fields) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

if (import.meta.url === `file://${process.argv[1]}` && process.env.HY_E2E_URL_FILE) {
  writeFileSync(process.env.HY_E2E_URL_FILE, target.toString());
} else if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const decision = process.env.HY_E2E_DECISION === 'deny' ? 'deny' : 'approve';
    // The pages are only useful to someone signed in; an anonymous visit is sent to /login.
    const anonymous = await fetch(target, { redirect: 'manual' });
    log('GET', target.pathname, anonymous.status, anonymous.headers.get('location') ?? '');
    const cookie = await signIn(base, process.env.HY_E2E_EMAIL, process.env.HY_E2E_PASSWORD);
    const page = await fetch(target, { headers: { Cookie: cookie }, redirect: 'manual' });
    const html = await page.text();
    log('GET (signed in)', target.pathname, page.status);

    if (target.pathname === '/authorize') {
      const fields = hiddenFields(html, '/authorize/decision');
      const res = await post(base, '/authorize/decision', cookie, { ...fields, decision });
      const out = await res.json();
      log('POST /authorize/decision', res.status, JSON.stringify(out).slice(0, 80));
      if (out.redirect) log('loopback', (await fetch(out.redirect)).status);
    } else {
      const path = `${target.pathname}/${decision}`;
      const res = await post(base, path, cookie, hiddenFields(html, path));
      log(`POST ${path}`, res.status, await res.text());
    }
  } catch (e) {
    log('error', e.stack);
    process.exit(1);
  }
}
