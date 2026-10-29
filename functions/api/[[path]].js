// The site's private data API (Cloudflare Pages only; _middleware.js has already checked the site password).
// Everything lives in the private GitHub repo DATA_REPO (default kyranl10/jarvis-data), one JSON file per item,
// e.g. jobs/<id>.json, mail/<id>.json, chat/<id>.json. Jarvis's scheduled tasks read and write the same files with git.
// Secrets in the Pages project: DATA_TOKEN (fine-grained GitHub token, Contents read/write on that repo only),
// and optionally ROUTINE_URL + ROUTINE_TOKEN (the "Jarvis requests" task's API trigger) so a tap wakes Jarvis at once.
// The quick AI buttons (chat, plans, resume tailoring, application help) run on Cloudflare's free Workers AI
// through the AI binding, so they answer in seconds and spend no Claude tokens.

const COLLECTIONS = ["jobs", "drafts", "help", "mail", "chat", "meta", "workshop", "hw"];
const PATH = new RegExp(`^(${COLLECTIONS.join("|")})/[A-Za-z0-9_.:@+-]{1,120}$`);
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const b64encode = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64decode = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const utf8 = { enc: (s) => b64encode(new TextEncoder().encode(s)), dec: (b) => new TextDecoder().decode(b64decode(b)) };

function gh(env) {
  const repo = env.DATA_REPO || "kyranl10/jarvis-data";
  const headers = { Authorization: `Bearer ${env.DATA_TOKEN}`, "User-Agent": "jarvis-site", Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28" };
  return {
    repo,
    rest: (path, init = {}) => fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } }),
    graphql: (query, variables) => fetch("https://api.github.com/graphql", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }),
  };
}

// Every file in the asked-for folders, in one GraphQL request (Pages Functions allow few subrequests)
async function list(env, cols) {
  const g = gh(env), [owner, name] = g.repo.split("/");
  const parts = cols.map((c) => `${c}: object(expression: "HEAD:${c}") { ... on Tree { entries { name object { ... on Blob { text } } } } }`);
  const res = await g.graphql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${parts.join(" ")} } }`, { o: owner, n: name });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error("GitHub said: " + JSON.stringify(body.errors || body.message || res.status).slice(0, 300));
  const out = {};
  for (const c of cols) {
    out[c] = {};
    for (const e of body.data.repository[c]?.entries || []) {
      if (!e.name.endsWith(".json") || e.object?.text == null) continue;
      try { out[c][e.name.slice(0, -5)] = JSON.parse(e.object.text); } catch (err) {}
    }
  }
  return out;
}

// Shallow merge; a null value removes the field
function merge(doc, patch) {
  const out = { ...doc };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}

// Read-modify-write one file, retrying if a scheduled task committed in between
async function save(env, path, { patch = {}, set = null, remove = false }) {
  const g = gh(env);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await g.rest(`contents/${path}.json`);
    let sha, doc = {};
    if (cur.ok) { const f = await cur.json(); sha = f.sha; try { doc = JSON.parse(utf8.dec(f.content)); } catch (e) {} }
    else if (cur.status !== 404) throw new Error("GitHub read failed: " + cur.status);
    if (remove) {
      if (!sha) return null;
      const del = await g.rest(`contents/${path}.json`, { method: "DELETE", body: JSON.stringify({ message: `Site: remove ${path}`, sha }) });
      if (del.ok) return null;
      if (del.status === 409 || del.status === 422) continue;
      throw new Error("GitHub delete failed: " + del.status);
    }
    const next = set ? set : merge(doc, patch);
    const put = await g.rest(`contents/${path}.json`, { method: "PUT", body: JSON.stringify({
      message: `Site: ${path}${patch.status ? " → " + patch.status : ""}`, content: utf8.enc(JSON.stringify(next, null, 2) + "\n"), ...(sha ? { sha } : {}) }) });
    if (put.ok) return next;
    if (put.status === 409 || put.status === 422) continue;
    throw new Error("GitHub write failed: " + put.status);
  }
  throw new Error("Kept colliding with another change. Try again.");
}

const RESUME_PDF = "resume/Kyran_Lakhia_Resume.pdf";
const IMAGE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export async function onRequest({ request, env, params }) {
  const route = (params.path || []).join("/");
  const url = new URL(request.url);
  try {
    if (route === "ping") return json({ ok: true, store: !!env.DATA_TOKEN, wake: !!(env.ROUTINE_URL && env.ROUTINE_TOKEN) });
    if (!env.DATA_TOKEN) return json({ error: "The site's data store isn't connected yet (DATA_TOKEN is missing)." }, 503);

    if (route === "list" && request.method === "GET") {
      const cols = (url.searchParams.get("c") || "").split(",").filter((c) => COLLECTIONS.includes(c));
      if (!cols.length) return json({ error: "Name at least one collection." }, 400);
      return json(await list(env, cols));
    }

    if (route === "save" && request.method === "POST") {
      const { path, patch, set, remove } = await request.json();
      if (!PATH.test(path || "")) return json({ error: "Bad path." }, 400);
      return json({ doc: await save(env, path, { patch: patch || {}, set: set || null, remove: !!remove }) });
    }

    // Screenshots for Jarvis: stored next to the data, referenced by path from the request that uses them
    if (route === "upload" && request.method === "POST") {
      const type = request.headers.get("Content-Type") || "";
      if (!IMAGE[type]) return json({ error: "Only PNG, JPEG, WebP or GIF images." }, 400);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024) return json({ error: "That image is over 4 MB." }, 400);
      const path = `uploads/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${IMAGE[type]}`;
      const put = await gh(env).rest(`contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Site: upload ${path}`, content: b64encode(bytes) }) });
      if (!put.ok) throw new Error("GitHub upload failed: " + put.status);
      return json({ path });
    }

    if (route === "file" && request.method === "GET") {
      const p = url.searchParams.get("p") || "";
      if (!/^uploads\/[A-Za-z0-9_.-]{1,80}$/.test(p)) return json({ error: "Bad path." }, 400);
      const res = await gh(env).rest(`contents/${p}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!res.ok) return json({ error: "Not found." }, 404);
      const ext = p.split(".").pop();
      const type = Object.keys(IMAGE).find((t) => IMAGE[t] === ext) || "application/octet-stream";
      return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
    }

    // His master resume PDF, kept in the private store (resume/) so it is only reachable behind the site password
    if (route === "resume" && request.method === "GET") {
      const res = await gh(env).rest(`contents/${RESUME_PDF}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!res.ok) return json({ error: "Your resume isn't in the store yet." }, 404);
      const name = RESUME_PDF.split("/").pop();
      return new Response(res.body, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store",
        "Content-Disposition": `${url.searchParams.has("dl") ? "attachment" : "inline"}; filename="${name}"` } });
    }

    // Wake Jarvis now instead of at its next scheduled run (the request itself is already saved)
    if (route === "wake" && request.method === "POST") {
      if (!env.ROUTINE_URL || !env.ROUTINE_TOKEN) return json({ woke: false, reason: "No API trigger set up; Jarvis picks this up on its next scheduled run." });
      const { text } = await request.json().catch(() => ({}));
      const url = env.ROUTINE_URL.trim().replace(/\/+$/, "").replace(/(\/routines\/[^/]+)$/, "$1/fire");
      const res = await fetch(url, { method: "POST", headers: {
        Authorization: `Bearer ${env.ROUTINE_TOKEN.trim()}`, "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01", "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(text || "A request is waiting on the Jarvis site.").slice(0, 2000) }) });
      return json({ woke: res.ok, status: res.status, ...(res.ok ? {} : { detail: (await res.text()).slice(0, 300) }) });
    }

    if (route === "ai" && request.method === "POST") {
      if (!env.AI) return json({ error: "The AI binding isn't set up yet. Add a Workers AI binding named AI in the Pages project settings." }, 503);
      const body = await request.json();
      const task = AI_TASKS[body.task];
      if (!task) return json({ error: "Unknown AI task." }, 400);
      return json(await task(env, body));
    }

    return json({ error: "Unknown route." }, 404);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
}

// ---------- Quick AI (Workers AI) ----------
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";   // fast, multimodal, inside the free daily allowance
const TZ = "America/New_York";
const nowEastern = () => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long",
  day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
const ABOUT = `Kyran: data science junior at UNC Chapel Hill (graduating May 2028), data analyst intern at VenueHorn, snare in the Marching Tar Heels drumline, marches with Paradigm (WGI) and DCI, member of Phi Mu Alpha. Skills: Python, R, SQL, Tableau, Excel, GitHub.`;

async function readDoc(env, path) {
  const res = await gh(env).rest(`contents/${path}.json`, { headers: { Accept: "application/vnd.github.raw+json" } });
  return res.ok ? res.json() : null;
}

async function imageParts(env, paths) {
  const out = [];
  for (const p of (paths || []).slice(0, 4)) {
    if (!/^uploads\/[A-Za-z0-9_.-]{1,80}$/.test(p)) continue;
    const res = await gh(env).rest(`contents/${p}`);
    if (!res.ok) continue;
    const f = await res.json(), ext = p.split(".").pop();
    const type = Object.keys(IMAGE).find((t) => IMAGE[t] === ext) || "image/png";
    out.push({ type: "image_url", image_url: { url: `data:${type};base64,${f.content.replace(/\s/g, "")}` } });
  }
  return out;
}

async function ask(env, messages, { max = 1200, wantJson = false } = {}) {
  const r = await env.AI.run(MODEL, { messages, max_tokens: max, temperature: 0.4 });
  let text = typeof r.response === "string" ? r.response : JSON.stringify(r.response ?? "");
  if (!wantJson) return text.trim();
  if (r.response && typeof r.response === "object") return r.response;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI's answer wasn't readable. Try again.");
  return JSON.parse(m[0]);
}

// The AI may reorder skills but must not drop or rename any: keep the base resume's lines and labels, and within
// each line put what the AI listed first (in its order) ahead of the rest. Lines follow the AI's order too.
function keepSkills(base = [], got = []) {
  const split = (v) => (Array.isArray(v) ? v.join(", ") : String(v || "")).split(/,(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
  const key = (x) => x.toLowerCase().replace(/\s+/g, " ");
  const order = new Map();
  for (const g of Array.isArray(got) ? got : []) for (const x of split(g.items)) if (!order.has(key(x))) order.set(key(x), order.size);
  const rank = (x) => order.has(key(x)) ? order.get(key(x)) : 1e6;
  return base.map((b) => ({ label: b.label, items: split(b.items).map((x, i) => [x, rank(x), i]).sort((p, q) => p[1] - q[1] || p[2] - q[2]).map((p) => p[0]) }))
    .sort((p, q) => Math.min(...p.items.map(rank)) - Math.min(...q.items.map(rank)))
    .map((b) => ({ label: b.label, items: b.items.join(", ") }));
}

const AI_TASKS = {
  // Chat: the browser keeps the conversation; screenshots arrive as uploaded paths
  async chat(env, { history = [], images = [], calendar = "" }) {
    const sys = `You are J.A.R.V.I.S., Kyran's personal assistant, in the style of Tony Stark's AI: calm, precise, quietly witty; address him as "sir". Keep replies short, two to five sentences unless he asks for more. Plain text only. Only greet him when he greets you, and match the hour (good morning 5am-noon, afternoon noon-5pm, evening after 5pm; after midnight, note the late hour). Don't claim to remember things beyond this chat.
Right now it is ${nowEastern()} in Chapel Hill, NC (Eastern Time). ${ABOUT}
${calendar ? "His upcoming calendar (from his HUD):\n" + String(calendar).slice(0, 4000) + "\nMention clashes with these when relevant; never claim he's free beyond what's listed." : "You can't see his calendar right now."}
Screenshots: read them carefully (who said what, timestamps) and resolve relative dates against the message date if shown, else today.
Calendar events: when a message or screenshot holds a plan he'd want on his calendar, end your reply with a fenced block starting with \`\`\`event holding a JSON array of {"title","start":"YYYY-MM-DDTHH:MM" Eastern (or "YYYY-MM-DD" all day),"end" (optional),"allDay":bool,"location","notes"}. Only when there's something to add; if the date or time is unclear, ask instead. Never say it's added; say tapping "Add to Outlook" saves it.
Building and changing things: Jarvis has a workshop that can change his HUD, pages and backend, and can write Outlook email drafts (he sends email only from his UNC Outlook). When he asks for that kind of work (or anything needing his email), reply briefly and end with a fenced block starting with \`\`\`workshop holding a complete, self-contained plain-text brief (the workshop can't see this chat). He taps "Send to Jarvis" to start it, so say it's ready to send, not done. Never put his phone, email, calendar links or notification topics into a brief.`;
    const turns = history.slice(-20).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.text || "").slice(0, 4000) }))
      .filter((m) => m.content.trim());
    const pics = await imageParts(env, images);
    if (pics.length && turns.length && turns[turns.length - 1].role === "user") {
      const last = turns.pop();
      turns.push({ role: "user", content: [{ type: "text", text: last.content || "What should I do with this?" }, ...pics] });
    }
    return { text: await ask(env, [{ role: "system", content: sys }, ...turns], { max: 900 }) };
  },

  // A plan for one email, saved onto it
  async plan(env, { id, note = "" }) {
    if (!/^[A-Za-z0-9_.:@+-]{1,120}$/.test(id || "")) throw new Error("Bad id.");
    const m = await readDoc(env, "mail/" + id);
    if (!m) throw new Error("That email isn't in the store.");
    const out = await ask(env, [{ role: "system", content: `You plan next steps on one email for Kyran. ${ABOUT}
Talk to him as "you", never "Kyran". Make steps concrete (what to open, write or decide, and by when). Reply with only JSON: {"summary": "1-2 honest sentences on fit, effort and blockers", "deadline": "short date or empty", "steps": [2-4 of {"who": "you"|"jarvis", "text": "one short step"}]}.
Jarvis steps may only be: write an Outlook email draft for him to send (never Gmail, never sent for him), write a cover letter or note, make a calendar event, or change his HUD. Never invent experience or facts that aren't in the email.` },
      { role: "user", content: `Email from ${m.from || "?"} (${m.at || ""}), subject: ${m.subject || ""}\n\nWhat it says: ${m.gist || ""}\n\n${String(m.body || "").slice(0, 6000)}\n\nWhy it matters: ${m.why || ""}${note ? "\n\nKyran's note: " + note : ""}` }],
      { max: 700, wantJson: true });
    const plan = { summary: String(out.summary || ""), deadline: String(out.deadline || ""),
      steps: (out.steps || []).slice(0, 4).map((s) => ({ who: s.who === "jarvis" ? "jarvis" : "you", text: String(s.text || "") })) };
    return { doc: await save(env, "mail/" + id, { patch: { plan, plannedAt: Date.now(), status: "open", decision: null, note: note || "" } }) };
  },

  // A resume tailored to one internship, using only facts from his base resume
  async tailor(env, { id, notes = "" }) {
    if (!/^[A-Za-z0-9_.:@+-]{1,120}$/.test(id || "")) throw new Error("Bad id.");
    const [job, resume, prev] = await Promise.all([readDoc(env, "jobs/" + id), readDoc(env, "meta/resume"), notes ? readDoc(env, "drafts/" + id) : null]);
    if (!job || !resume) throw new Error("The job or your base resume isn't in the store.");
    const out = await ask(env, [{ role: "system", content: `You tailor a college student's resume for one internship.
Hard rules: use ONLY facts in the base resume; never invent jobs, projects, skills, tools, numbers, awards or dates. Keep every skill and tool from the base resume with the same labels; you may only reorder them to lead with what the posting wants. You may reorder sections, entries and bullets, reword bullets with the posting's vocabulary where truthful, and drop less relevant bullets. One page: at most about 16 bullets. Keep name and contact exactly.
Reply with only JSON: {"resume": <same shape as the base resume>, "changes": [up to 5 short strings], "answers": {"Why this company": "2-3 first-person sentences specific to the posting", "Why you're a fit": "2-3 sentences tying real experience to the role"}}` },
      { role: "user", content: `BASE RESUME:\n${JSON.stringify(resume)}\n\nINTERNSHIP:\n${JSON.stringify({ company: job.company, title: job.title, locations: job.locations, terms: job.terms, details: job.details || {} })}${
        notes && prev ? `\n\nPREVIOUS TAILORED VERSION:\n${JSON.stringify(prev.resume)}\n\nHIS NOTES (follow them within the hard rules):\n${notes}` : ""}` }],
      { max: 3000, wantJson: true });
    if (!out.resume || !Array.isArray(out.resume.sections)) throw new Error("The tailored resume came back garbled. Try again.");
    out.resume.skills = keepSkills(resume.skills, out.resume.skills);
    const draft = { resume: out.resume, changes: (out.changes || []).slice(0, 6).map(String),
      answers: out.answers && typeof out.answers === "object" ? out.answers : {}, made: Date.now() };
    await save(env, "drafts/" + id, { set: draft });
    const doc = await save(env, "jobs/" + id, { patch: { status: "review", updated: Date.now() } });
    return { draft, doc };
  },

  // What to do on the application screen he's looking at
  async help(env, { id, question = "", images = [] }) {
    if (!/^[A-Za-z0-9_.:@+-]{1,120}$/.test(id || "")) throw new Error("Bad id.");
    const [job, resume, draft] = await Promise.all([readDoc(env, "jobs/" + id), readDoc(env, "meta/resume"), readDoc(env, "drafts/" + id)]);
    const pics = await imageParts(env, images);
    const text = `STUDENT'S RESUME:\n${JSON.stringify(resume || {})}\n\nINTERNSHIP:\n${JSON.stringify(job ? { company: job.company, title: job.title, status: job.status, details: job.details || {} } : {})}${
      draft?.answers ? "\n\nTAILORED ANSWERS ALREADY WRITTEN:\n" + JSON.stringify(draft.answers) : ""}\n\n${pics.length ? pics.length + " screenshot(s) of the application are attached." : "No screenshot attached."}\nQUESTION: ${question || "What should I do on this screen?"}`;
    const advice = await ask(env, [{ role: "system", content: `You are Jarvis, helping a college student fill out an internship application right now. Read every visible field, dropdown and error in the screenshots. Say exactly what to do on this screen, field by field where it matters. Use only facts from the resume and internship; never invent experience, GPAs or eligibility answers (say "answer truthfully" instead). Point out autofill mistakes. Draft short answers to essay questions using the tailored answers when given. Be brief: short lines, "-" bullets, no headings or bold. Lead with the most important fix.` },
      { role: "user", content: pics.length ? [{ type: "text", text }, ...pics] : text }], { max: 1000 });
    const rec = { at: Date.now(), question, advice };
    await save(env, "help/" + id, { set: rec });
    return rec;
  },
};
