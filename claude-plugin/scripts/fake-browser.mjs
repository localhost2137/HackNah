#!/usr/bin/env node
// Headless stand-in for `open <url>`: follows redirects like a browser would.
// Used by tests with HY_BROWSER_CMD="node scripts/fake-browser.mjs".
let url = process.argv[2];
for (let i = 0; i < 10 && url; i++) {
  const res = await fetch(url, { redirect: 'manual' });
  url = res.headers.get('location') ? new URL(res.headers.get('location'), url).toString() : null;
}
