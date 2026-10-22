// Access gate for the DeWitt Firm Health preview. Runs on Vercel before any file is served.
export const config = { matcher: '/:path*' };

// SHA-256 of the access password; the password itself is not stored in the code.
const PASS_SHA256 = 'fd27a3bd619e7d3e73a8952a7a663cc8be36a199cd459739df5e08dfaf067116';
const COOKIE = 'fh_access';
const TOKEN = 'dnl-fh-a2c277bb6d04bf52fcfa57f5301d3b56c17ce22aee12cc1c';

const page = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>DeWitt Firm Health</title>
<style>:root{--bg:#f2f2f7;--fg:#1d1d1f;--mut:#6e6e73;--card:rgba(255,255,255,.8);--acc:#0071e3;--bad:#d70015;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--mut:#98989d;--card:rgba(44,44,46,.7);--acc:#2997ff;--bad:#ff453a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif}
form{width:min(100%,340px);padding:28px;border-radius:20px;background:var(--card);box-shadow:0 14px 36px -10px rgba(30,40,80,.25)}
p{margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}h1{margin:0 0 20px;font-size:26px;letter-spacing:-.02em}
label{display:block;font-size:13px;color:var(--mut);margin-bottom:6px}input{width:100%;font:inherit;font-size:20px;letter-spacing:.05em;padding:10px 12px;border-radius:10px;border:1px solid rgba(120,120,128,.35);background:transparent;color:var(--fg)}
input:focus{outline:3px solid color-mix(in srgb,var(--acc) 45%,transparent)}button{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:10px;background:var(--acc);color:#fff;cursor:pointer}
.e{color:var(--bad);font-size:13px;margin-top:10px}</style></head><body>
<form method="post" action="/__access"><p>DeWitt Law</p><h1>Firm Health</h1><label for="pin">Password</label><input id="pin" name="pin" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" autofocus required>${error ? '<div class="e" role="alert">Wrong password. Try again.</div>' : ''}<button type="submit">Open dashboard</button></form></body></html>`;

const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

const html = (body, status) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });

export default async function middleware(request) {
  const url = new URL(request.url);
  if (url.pathname === '/__access' && request.method === 'POST') {
    const pin = new URLSearchParams(await request.text()).get('pin');
    if (pin && pin.length <= 200 && (await sha256(pin.trim())) === PASS_SHA256) {
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`, 'cache-control': 'no-store' } });
    }
    await new Promise((r) => setTimeout(r, 1500));
    return html(page(true), 401);
  }
  const cookie = request.headers.get('cookie') || '';
  if (cookie.split(/;\s*/).includes(`${COOKIE}=${TOKEN}`)) return; // signed in: serve the file
  return html(page(false), 401);
}