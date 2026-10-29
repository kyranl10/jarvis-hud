// Store: kyranl10/jarvis-data (private). Needs DATA_TOKEN, the Workers AI binding "AI" and the routine trigger secrets.
// Shared helpers for the Jarvis pages. On the Cloudflare site, /api is the private data store and the quick AI;
// on the public GitHub Pages copy it doesn't exist, so pages fall back to their public, read-only data.
const J = (() => {
  const post = async (path, body, type) => {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": type || "application/json" },
      body: type ? body : JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) { location.reload(); throw new Error("Signed out."); }
    if (!res.ok) throw new Error(out.error || "That didn't go through. Try again.");
    return out;
  };
  let pinged = null;
  return {
    // {store, wake} when this is the private site, null on GitHub Pages
    ping() {
      return pinged ||= fetch("/api/ping", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
        .then((p) => (p && p.ok && p.store ? p : null)).catch(() => null);
    },
    async list(...cols) {
      const res = await fetch("/api/list?c=" + cols.join(","), { cache: "no-store" });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "Couldn't load your data.");
      return out;
    },
    save: (path, patch) => post("/api/save", { path, patch }),
    set: (path, doc) => post("/api/save", { path, set: doc }),
    remove: (path) => post("/api/save", { path, remove: true }),
    ai: (task, args) => post("/api/ai", { task, ...args }),
    wake: (text) => post("/api/wake", { text }).catch(() => ({ woke: false })),
    async upload(file) { return (await post("/api/upload", file, file.type)).path; },
    file: (p) => "/api/file?p=" + encodeURIComponent(p),
    esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    safeUrl: (u) => /^https:\/\//i.test(String(u || "")) ? String(u) : "",
    // Refresh on a timer while the tab is visible, and right away when it comes back
    poll(fn, ms) {
      setInterval(() => { if (!document.hidden) fn(); }, ms);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) fn(); });
    },
  };
})();

// On iPhone and iPad, Gmail web links open the Gmail app instead of Safari, where Google shows its sign-up page.
// The app rejects every link format for a single email (tested Oct 29), so the tap copies the email's subject
// for pasting into Gmail's search, then opens the app.
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!ios) return;
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return; } catch (err) {}
    const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta); ta.setSelectionRange(0, text.length);
    try { document.execCommand("copy"); } catch (err) {}
    ta.remove();
  };
  document.addEventListener("click", async (e) => {
    const a = e.target.closest && e.target.closest('a[href^="https://mail.google.com/"]');
    if (!a || e.defaultPrevented) return;
    e.preventDefault();
    // Mail cards carry the subject in their heading; the HUD's Messages rows use it as the link text
    const card = a.closest("article")?.querySelector("h3")?.textContent || "";
    const subject = (card || (/^open in gmail$/i.test(a.textContent.trim()) ? "" : a.textContent))
      .trim().replace(/^((re|fwd?|fw)\s*:\s*)+/i, "");
    if (subject) await copy(subject);
    // Pages run inside index.html's tab frames, and iOS ignores app links opened from a frame, so open it from the top page
    try { window.top.location.href = "googlegmail://"; } catch (err) { location.href = "googlegmail://"; }
  });
})();
