// Store: kyranl10/jarvis-data (private). Deploys pick up DATA_TOKEN, the AI binding and the routine trigger.
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
