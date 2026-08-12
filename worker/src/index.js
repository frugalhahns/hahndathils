/**
 * Upload doorman for the trip site.
 *
 * The site is static on GitHub Pages, which cannot accept a file upload. This
 * Worker takes one, checks the trip passphrase, and commits it to the repo with
 * a token that never leaves the server. Uploaders need no GitHub account.
 *
 * Secrets (wrangler secret put):
 *   GH_TOKEN         fine-grained PAT, Contents: read and write, this repo only
 *   TRIP_PASSPHRASE  same passphrase the site is gated behind
 */

const MAX_BYTES = 8 * 1024 * 1024; // generous; the browser resizes to ~300 KB
const ALLOWED_ORIGINS = [
  "https://frugalhahns.github.io",
  "http://localhost:8000",
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

/** Compare without leaking length or position through timing. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || "");
  const y = enc.encode(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** photo-20260814-093102-a1b2c3.jpg */
function buildName(takenISO) {
  const d = takenISO && !isNaN(Date.parse(takenISO)) ? new Date(takenISO) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `photo-${stamp}-${rand}.jpg`;
}

async function commitFile(env, path, base64) {
  const url = `https://api.github.com/repos/${env.REPO}/contents/${path}`;

  // Two people uploading at once can race on the branch head. Creating a new
  // path never needs a base SHA, so a retry is enough to settle it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "hahndathils-upload-worker",
      },
      body: JSON.stringify({
        message: `add: ${path}`,
        content: base64,
        branch: env.BRANCH,
      }),
    });

    if (res.ok) return { ok: true, path };
    if (res.status !== 409 && res.status !== 422) {
      return { ok: false, status: res.status, detail: await res.text() };
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return { ok: false, status: 409, detail: "branch kept moving under us" };
}

/* One file per quote, so two people adding at the same time cannot clobber
   each other. Appending to a single JSON array would need a read, a merge, and
   a write against a moving branch. */
async function saveQuote(env, body, origin) {
  const text = String(body.text || "").trim();
  const who = String(body.who || "").trim();
  const when = String(body.when || "").trim();

  if (!text) return json({ error: "no quote" }, 400, origin);
  if (text.length > 600 || who.length > 60 || when.length > 40) {
    return json({ error: "too long" }, 413, origin);
  }

  const record = { text, who, when, added: new Date().toISOString() };
  const stamp = record.added.replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `quotes/${stamp}-${rand}.json`;

  // btoa is latin1 only, so encode to UTF-8 bytes first or an emoji breaks it.
  const bytes = new TextEncoder().encode(JSON.stringify(record, null, 1));
  const base64 = btoa(String.fromCharCode(...bytes));

  const result = await commitFile(env, path, base64);
  if (!result.ok) {
    console.error("quote commit failed", result.status, result.detail);
    return json({ error: "could not save quote" }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    const isUpload = pathname === "/upload";
    const isQuote = pathname === "/quote";
    if ((!isUpload && !isQuote) || request.method !== "POST") {
      return json({ error: "not found" }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "expected JSON" }, 400, origin);
    }

    if (!safeEqual(body.pass, env.TRIP_PASSPHRASE)) {
      return json({ error: "wrong passphrase" }, 401, origin);
    }
    if (isQuote) return saveQuote(env, body, origin);

    if (typeof body.data !== "string" || !body.data) {
      return json({ error: "no image data" }, 400, origin);
    }
    // base64 inflates by 4/3, so compare against the decoded size.
    if (body.data.length * 0.75 > MAX_BYTES) {
      return json({ error: "image too large" }, 413, origin);
    }

    const name = buildName(body.taken);
    const result = await commitFile(env, `${env.PHOTO_DIR}/${encodeURIComponent(name)}`, body.data);
    if (!result.ok) {
      console.error("commit failed", result.status, result.detail);
      return json({ error: "could not save photo" }, 502, origin);
    }
    return json({ ok: true, name }, 200, origin);
  },
};
