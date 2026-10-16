// Cloudflare Pages only (GitHub Pages ignores this folder): every request needs the site password.
// The password lives in the Pages project's SITE_PASSWORD variable, never in this public repo.
// A correct password sets a year-long cookie holding a hash of it, so changing the password signs every device out.
const COOKIE = "jarvis_auth";

async function token(password) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("jarvis-site:" + password));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

const page = (note) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#04080d"><title>Jarvis</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#04080d;color:#d7f6ff;font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;color-scheme:dark}
body{display:grid;place-items:center;min-height:100dvh;padding:16px}
form{width:min(340px,100%);display:grid;gap:12px;border:1px solid rgba(111,227,255,.22);padding:24px;background:rgba(20,60,80,.18)}
h1{margin:0;font:600 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3em;color:#6fe3ff}
input,button{font:inherit;font-size:16px;padding:12px;border:1px solid rgba(111,227,255,.35);background:#04080d;color:#d7f6ff}
button{background:rgba(111,227,255,.14);border-color:#6fe3ff;color:#6fe3ff;cursor:pointer;letter-spacing:.08em;text-transform:uppercase}
input:focus-visible,button:focus-visible{outline:1px solid #6fe3ff;outline-offset:2px}
p{margin:0;color:#ff6b5b;font-size:14px;min-height:1.2em}
</style></head><body>
<form id="f"><h1>JARVIS</h1>
<input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus required>
<button>Unlock</button><p id="note" role="status">${note}</p></form>
<script>
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch("/__login", { method: "POST", body: document.getElementById("pw").value });
  if (res.ok) location.reload();  // reload keeps the #key in the address
  else document.getElementById("note").textContent = "Wrong password.";
};
</script></body></html>`, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export async function onRequest({ request, env, next }) {
  const password = env.SITE_PASSWORD;
  if (!password) return page("The site password isn't set yet. Add SITE_PASSWORD in the Pages project settings.");
  const want = await token(password);
  const url = new URL(request.url);

  if (url.pathname === "/__login" && request.method === "POST") {
    const given = await token((await request.text()).slice(0, 200));
    if (!same(given, want)) return new Response("no", { status: 403 });
    return new Response("ok", { headers: {
      "Set-Cookie": `${COOKIE}=${want}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    } });
  }

  if (!same(cookie(request, COOKIE), want)) return page("");
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  return out;
}
