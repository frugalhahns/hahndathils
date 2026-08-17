/**
 * Upload doorman for the trip site.
 *
 * The site is static on GitHub Pages, which cannot accept a file upload. This
 * Worker takes one, checks the trip passphrase, and commits it to the repo with
 * a token that never leaves the server. Uploaders need no GitHub account.
 *
 * The site itself is public, so the token below is not a secret in any real
 * sense: it ships in the page source. It exists to stop drive-by scanners from
 * posting to the endpoint, and so it can be rotated without touching anything
 * else. Anyone who reads the page can upload.
 *
 * It also keeps a private view log. /seen takes a beacon from the page, and
 * /seen/log renders it for the owner only. The page never shows any of it.
 *
 * Secrets (wrangler secret put):
 *   GH_TOKEN         fine-grained PAT, Contents: read and write, this repo only
 *   UPLOAD_TOKEN     must match CONFIG.uploadToken in assets/app.js
 *   DASHBOARD_TOKEN  long random string, gates /seen/log. Unlike UPLOAD_TOKEN
 *                    this one is a real secret: it must never ship in the page.
 */

const MAX_BYTES = 8 * 1024 * 1024; // generous; the browser resizes to ~300 KB
const ALLOWED_ORIGINS = [
  "https://frugalhahns.github.io",
  "http://localhost:8000",
];

/* Visits older than this are dropped on the next write. Three years is long
   enough to keep several trips' worth of history; the point of the cutoff is
   that this is IP data, not that the rows cost anything. Device labels live in
   their own table and are never expired. */
const RETAIN_DAYS = 1095;
const RETAIN_LABEL = "3 years";
const DASH_COOKIE = "hd_seen";

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

/* ---------------------------------------------------------------------- */
/* Private view log                                                        */
/* ---------------------------------------------------------------------- */

/* Cloudflare hands us the geo for free on request.cf, which matters because a
   raw IP goes stale. Once someone's IP rotates, "Ithaca / Charter" is still
   recognisable where 24.58.x.x is not. */
async function recordVisit(request, env, body, origin) {
  if (!env.SEEN) return json({ error: "view log not configured" }, 503, origin);

  const device = String(body.device || "");
  if (!/^[a-z0-9]{8,40}$/i.test(device)) {
    return json({ error: "bad device id" }, 400, origin);
  }

  const cf = request.cf || {};
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString();
  const trim = (v, n) => (v == null ? null : String(v).slice(0, n));

  try {
    await env.SEEN.batch([
      env.SEEN.prepare(
        `INSERT INTO visits (at, device, ip, city, region, country, asn, isp, ua, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        now,
        device,
        request.headers.get("CF-Connecting-IP") || null,
        trim(cf.city, 80),
        trim(cf.region, 80),
        trim(cf.country, 8),
        typeof cf.asn === "number" ? cf.asn : null,
        trim(cf.asOrganization, 120),
        trim(request.headers.get("User-Agent"), 300),
        trim(body.ref, 300)
      ),
      // first_seen must survive the upsert; last_seen always moves forward.
      env.SEEN.prepare(
        `INSERT INTO devices (device, label, first_seen, last_seen)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(device) DO UPDATE SET last_seen = excluded.last_seen`
      ).bind(device, now, now),
      env.SEEN.prepare(`DELETE FROM visits WHERE at < ?`).bind(cutoff),
    ]);
  } catch (e) {
    console.error("view log write failed", e.message);
    return json({ error: "could not record" }, 502, origin);
  }

  // The page ignores the response; give it nothing to parse.
  return new Response(null, { status: 204, headers: cors(origin) });
}

/* The token can arrive as ?key= once, which then becomes an httpOnly cookie so
   it stops appearing in the URL bar and in any Referer this page might leak. */
function dashAuth(request, env) {
  if (!env.DASHBOARD_TOKEN) return { ok: false, reason: "DASHBOARD_TOKEN is not set" };

  const key = new URL(request.url).searchParams.get("key");
  if (key) {
    return safeEqual(key, env.DASHBOARD_TOKEN)
      ? { ok: true, setCookie: true }
      : { ok: false, reason: "bad key" };
  }
  const m = (request.headers.get("Cookie") || "").match(
    new RegExp(`(?:^|;\\s*)${DASH_COOKIE}=([^;]+)`)
  );
  if (m && safeEqual(decodeURIComponent(m[1]), env.DASHBOARD_TOKEN)) return { ok: true };
  return { ok: false, reason: "unauthorized" };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function dashPage(devices, visits) {
  const ago = (iso) => {
    const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  const deviceRows = devices
    .map(
      (d) => `<tr>
      <td><form method="post" class="lbl">
        <input type="hidden" name="device" value="${esc(d.device)}">
        <input name="label" value="${esc(d.label || "")}" placeholder="unlabelled" size="14">
        <button>save</button>
      </form></td>
      <td class="mono dim">${esc(d.device.slice(0, 8))}</td>
      <td>${esc(d.visits)}</td>
      <td>${esc(ago(d.last_seen))}</td>
      <td>${esc(d.where_last || "?")}</td>
      <td>${esc(d.isp_last || "?")}</td>
      <td class="mono dim">${esc(d.ip_last || "?")}</td>
    </tr>`
    )
    .join("");

  const byDevice = new Map(devices.map((d) => [d.device, d.label]));
  const visitRows = visits
    .map(
      (v) => `<tr>
      <td class="mono">${esc(v.at.replace("T", " ").slice(0, 16))}</td>
      <td>${esc(byDevice.get(v.device) || v.device.slice(0, 8))}</td>
      <td>${esc([v.city, v.region, v.country].filter(Boolean).join(", ") || "?")}</td>
      <td>${esc(v.isp || "?")}</td>
      <td class="mono dim">${esc(v.ip || "?")}</td>
    </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>who has looked</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1rem;
         background: #14171c; color: #e6e8ec; }
  main { max-width: 62rem; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2.5rem 0 .5rem; color: #9aa3b2; font-weight: 600; }
  p.sub { color: #9aa3b2; margin: 0 0 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #262b33; }
  th { color: #9aa3b2; font-weight: 600; font-size: .8rem; text-transform: uppercase;
       letter-spacing: .04em; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .dim { color: #7f8895; }
  form.lbl { display: flex; gap: .3rem; margin: 0; }
  input, button { font: inherit; background: #1d222a; color: inherit;
                  border: 1px solid #333a45; border-radius: 4px; padding: .15rem .4rem; }
  button { cursor: pointer; }
  tr:hover td { background: #191d24; }
</style></head>
<body><main>
  <h1>Who has looked at the trip site</h1>
  <p class="sub">One row per browser. Label a device once and the name sticks.
     Visits older than ${RETAIN_LABEL} are deleted automatically; the names you
     assign are kept regardless.</p>

  <h2>Devices (${devices.length})</h2>
  <table><thead><tr>
    <th>Who</th><th>Device</th><th>Visits</th><th>Last seen</th>
    <th>Where</th><th>Network</th><th>Last IP</th>
  </tr></thead><tbody>${deviceRows || `<tr><td colspan="7" class="dim">nothing yet</td></tr>`}</tbody></table>

  <h2>Recent visits (${visits.length})</h2>
  <table><thead><tr>
    <th>When (UTC)</th><th>Who</th><th>Where</th><th>Network</th><th>IP</th>
  </tr></thead><tbody>${visitRows || `<tr><td colspan="5" class="dim">nothing yet</td></tr>`}</tbody></table>
</main></body></html>`;
}

async function dashboard(request, env) {
  const auth = dashAuth(request, env);
  if (!auth.ok) {
    return new Response(`not found\n`, {
      status: 404, // do not advertise that this path means anything
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (!env.SEEN) {
    return new Response("view log not configured: no SEEN binding\n", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Drop the key from the URL as soon as it has been turned into a cookie.
  if (auth.setCookie) {
    const clean = new URL(request.url);
    clean.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: clean.pathname,
        "Set-Cookie":
          `${DASH_COOKIE}=${encodeURIComponent(env.DASHBOARD_TOKEN)}; ` +
          `HttpOnly; Secure; SameSite=Lax; Path=/seen; Max-Age=31536000`,
      },
    });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const device = String(form.get("device") || "");
    const label = String(form.get("label") || "").trim().slice(0, 40);
    if (/^[a-z0-9]{8,40}$/i.test(device)) {
      await env.SEEN.prepare(`UPDATE devices SET label = ? WHERE device = ?`)
        .bind(label || null, device)
        .run();
    }
    return new Response(null, { status: 303, headers: { Location: "/seen/log" } });
  }

  const [devices, visits] = await Promise.all([
    env.SEEN.prepare(
      `SELECT d.device, d.label, d.first_seen, d.last_seen,
              (SELECT COUNT(*) FROM visits v WHERE v.device = d.device) AS visits,
              (SELECT TRIM(COALESCE(v.city,'') || ', ' || COALESCE(v.region,''), ', ')
                 FROM visits v WHERE v.device = d.device
                ORDER BY v.at DESC LIMIT 1) AS where_last,
              (SELECT v.isp FROM visits v WHERE v.device = d.device
                ORDER BY v.at DESC LIMIT 1) AS isp_last,
              (SELECT v.ip  FROM visits v WHERE v.device = d.device
                ORDER BY v.at DESC LIMIT 1) AS ip_last
         FROM devices d
        ORDER BY d.last_seen DESC`
    ).all(),
    env.SEEN.prepare(
      `SELECT at, device, ip, city, region, country, isp
         FROM visits ORDER BY at DESC LIMIT 200`
    ).all(),
  ]);

  return new Response(dashPage(devices.results || [], visits.results || []), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // The owner's dashboard. Checked before the token gate below, because it
    // authenticates with DASHBOARD_TOKEN instead and is not a JSON endpoint.
    if (pathname === "/seen/log") return dashboard(request, env);

    const isUpload = pathname === "/upload";
    const isQuote = pathname === "/quote";
    const isSeen = pathname === "/seen";
    if ((!isUpload && !isQuote && !isSeen) || request.method !== "POST") {
      return json({ error: "not found" }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "expected JSON" }, 400, origin);
    }

    if (!safeEqual(body.token, env.UPLOAD_TOKEN)) {
      return json({ error: "bad token" }, 401, origin);
    }
    if (isSeen) return recordVisit(request, env, body, origin);
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
