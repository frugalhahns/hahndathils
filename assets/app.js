// Hahndathils trip site. No framework, no build step.
// Reads data/site.json (public) and decrypts data/private.enc.json on demand.

const CONFIG = {
  // Filled in after the repo exists. Photos are read straight from the
  // GitHub contents API, so uploading a file to /photos is the whole workflow.
  photoRepo: "frugalhahns/hahndathils",
  photoDir: "photos",
  photoBranch: "main",
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let SITE = null; // populated only after a successful unlock

// ---------------------------------------------------------------- helpers

const IMG_RE = /\.(jpe?g|png|gif|webp|avif)$/i;

function wxEmoji(short) {
  const s = (short || "").toLowerCase();
  if (/thunder|t-storm/.test(s)) return "⛈️";
  if (/snow|flurr|sleet|winter/.test(s)) return "🌨️";
  if (/rain|shower|drizzle/.test(s)) return "🌧️";
  if (/fog|haze|mist|smoke/.test(s)) return "🌫️";
  if (/mostly cloudy|overcast/.test(s)) return "☁️";
  if (/partly (sunny|cloudy)|mostly sunny|few clouds/.test(s)) return "⛅";
  if (/cloud/.test(s)) return "☁️";
  if (/clear|sunny|fair/.test(s)) return "☀️";
  return "🌡️";
}

// Parse 'YYYY-MM-DD' as a local date. `new Date(str)` would read it as UTC and
// shift the day backwards for anyone west of Greenwich.
function localDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const todayISO = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

const dayName = (iso) =>
  localDate(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

const shortDay = (iso) =>
  localDate(iso).toLocaleDateString(undefined, { weekday: "short" });

function daysBetween(aISO, bISO) {
  return Math.round((localDate(bISO) - localDate(aISO)) / 86400000);
}

function mapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// ---------------------------------------------------------------- countdown

function renderCountdown() {
  const { start, end } = SITE.trip;
  const node = $("#countdown");
  if (!start) { node.textContent = ""; return; }
  const today = todayISO();
  const toStart = daysBetween(today, start);
  const total = daysBetween(start, end) + 1;

  if (toStart > 1) node.textContent = `${toStart} days out · ${dayName(start)} to ${dayName(end)}`;
  else if (toStart === 1) node.textContent = `Tomorrow · ${dayName(start)} to ${dayName(end)}`;
  else if (toStart <= 0 && daysBetween(today, end) >= 0)
    node.textContent = `Day ${daysBetween(start, today) + 1} of ${total}`;
  else node.textContent = `${dayName(start)} to ${dayName(end)} · that was ${daysBetween(end, today)} days ago`;
}

// ---------------------------------------------------------------- now card

function nextStop() {
  const now = new Date();
  const today = todayISO();
  return SITE.itinerary.find((s) => {
    if (s.date > today) return true;
    if (s.date < today) return false;
    if (!s.time) return true;
    const [h, m] = s.time.split(":").map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m) >= now;
  });
}

function currentHour(locKey) {
  const hours = SITE.weather[locKey]?.hourly || [];
  const now = Date.now();
  return hours.find((h) => new Date(h.start).getTime() + 3600000 > now) || hours[0];
}

function renderNow() {
  const stop = nextStop();
  const locKey = stop?.wx || "cortland";
  const hour = currentHour(locKey);
  if (!hour && !stop) return;

  const card = $("#now");
  card.innerHTML = "";

  if (hour) {
    card.append(el("div", "big", wxEmoji(hour.short)));
    const t = el("div");
    t.append(el("div", "now-temp", `${hour.temp}°F`));
    t.append(el("div", "muted", `${hour.short} · ${SITE.weather[locKey].label}`));
    if (hour.pop) t.append(el("div", "pop", `${hour.pop}% precip`));
    card.append(t);
  }

  if (stop) {
    const n = el("div", "now-next");
    const when = stop.date === todayISO() ? `Today ${stop.timeLabel}` : `${shortDay(stop.date)} ${stop.timeLabel}`;
    n.append(el("div", "muted", `Up next · ${when}`));
    n.append(el("div", "stop-title", stop.activity));
    card.append(n);
  }
  card.hidden = false;
}

// ---------------------------------------------------------------- itinerary

function dayHigh(dateISO, locKey) {
  const periods = SITE.weather[locKey]?.daily || [];
  return periods.find((p) => p.day && p.start.slice(0, 10) === dateISO);
}

function renderStop(stop) {
  const row = el("div", "stop");
  row.dataset.id = stop.id;

  row.append(el("div", "stop-time", stop.timeLabel || "..."));

  const body = el("div");
  body.append(el("div", "stop-title", stop.activity));

  const meta = el("div", "stop-meta");
  if (stop.type) meta.append(el("span", "tag", stop.type));

  if (stop.address) {
    const a = el("a", "addr", stop.address);
    a.href = mapsUrl(stop.address);
    a.target = "_blank";
    a.rel = "noopener";
    meta.append(a);
  } else if (stop.town) {
    meta.append(el("span", null, stop.town));
  }

  const hourly = SITE.weather[stop.wx]?.hourly || [];
  const at = hourly.find((h) => h.start.slice(0, 10) === stop.date && h.start.slice(11, 13) === (stop.time || "").slice(0, 2));
  if (at) meta.append(el("span", "wx-chip", `${wxEmoji(at.short)} ${at.temp}° · ${at.pop}%`));

  if (stop.link) {
    const a = el("a", null, "link ↗");
    a.href = stop.link;
    a.target = "_blank";
    a.rel = "noopener";
    meta.append(a);
  }
  if (stop.privateLink) {
    const a = el("a", null, "booking ↗");
    a.href = stop.privateLink;
    a.target = "_blank";
    a.rel = "noopener";
    meta.append(a);
  }
  body.append(meta);

  if (stop.notes) {
    const note = el("div", "stop-note", stop.notes);
    const long = stop.notes.length > 90;
    note.hidden = long;
    const btn = el("button", "note-toggle", long ? "Show notes" : "Hide notes");
    btn.hidden = !long;
    btn.onclick = () => {
      note.hidden = !note.hidden;
      btn.textContent = note.hidden ? "Show notes" : "Hide notes";
    };
    body.append(btn, note);
  }

  row.append(body);
  return row;
}

function renderItinerary() {
  const host = $("#days");
  const nav = $("#daynav-inner");
  const today = todayISO();
  const dates = [...new Set(SITE.itinerary.map((s) => s.date))];

  dates.forEach((date) => {
    const stops = SITE.itinerary.filter((s) => s.date === date);
    const sec = el("section", "day");
    sec.id = `d-${date}`;

    const head = el("div", "day-head");
    head.append(el("h3", null, dayName(date)));
    if (date === today) head.append(el("span", "tag", "today"));

    const hi = dayHigh(date, stops[0].wx);
    if (hi) head.append(el("span", "day-wx", `${wxEmoji(hi.short)} ${hi.temp}°F · ${hi.pop}% precip`));
    sec.append(head);

    stops.forEach((s) => sec.append(renderStop(s)));
    host.append(sec);

    const a = el("a", date === today ? "is-today" : null, shortDay(date));
    a.href = `#d-${date}`;
    nav.append(a);
  });
}

// ---------------------------------------------------------------- forecast

function renderForecast(locKey) {
  const host = $("#forecast-body");
  host.innerHTML = "";
  const periods = (SITE.weather[locKey]?.daily || []).filter((p) => p.day);
  const nights = (SITE.weather[locKey]?.daily || []).filter((p) => !p.day);

  periods.forEach((p) => {
    const date = p.start.slice(0, 10);
    const night = nights.find((n) => n.start.slice(0, 10) === date);
    const row = el("div", "wx-row");

    const d = el("div", "wx-day", p.name);
    d.append(el("small", null, localDate(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })));
    row.append(d);

    row.append(el("div", "wx-icon", wxEmoji(p.short)));

    const desc = el("div", "wx-desc", p.short);
    if (p.pop) desc.append(el("div", "pop", `${p.pop}% precip · ${p.wind}`));
    row.append(desc);

    const temp = el("div", "wx-temp");
    temp.append(el("b", null, `${p.temp}°`));
    if (night) temp.append(el("small", null, ` / ${night.temp}°`));
    row.append(temp);

    row.title = p.detail;
    host.append(row);
  });
}

function renderLocTabs() {
  const tabs = $("#loc-tabs");
  SITE.locations.forEach((loc, i) => {
    const b = el("button", i === 0 ? "is-on" : null, loc.label);
    b.onclick = () => {
      tabs.querySelectorAll("button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      renderForecast(loc.key);
    };
    tabs.append(b);
  });
  renderForecast(SITE.locations[0].key);
}

// ---------------------------------------------------------------- ideas

function renderIdeas(filter = "all") {
  const host = $("#ideas-body");
  host.innerHTML = "";
  SITE.ideas
    .filter((i) => filter === "all" || (filter === "indoor" ? i.indoor : !i.indoor))
    .forEach((i) => {
      const c = el("div", "idea");
      const h = el("h4");
      const a = el("a", null, i.name);
      a.href = i.url; a.target = "_blank"; a.rel = "noopener";
      h.append(a);
      c.append(h, el("p", null, i.blurb));
      const foot = el("div", "idea-foot");
      foot.append(el("span", "tag", i.indoor ? "indoor" : "outdoor"));
      foot.append(el("span", null, i.town));
      if (i.drive) foot.append(el("span", null, i.drive));
      c.append(foot);
      host.append(c);
    });
}

function renderEvents() {
  if (!SITE.events?.length) return;
  const host = $("#events-body");
  host.className = "event-list";
  host.append(el("h3", null, "Happening this week"));
  SITE.events.forEach((e) => {
    const row = el("div", "event");
    const a = el("a", null, e.name);
    a.href = e.url; a.target = "_blank"; a.rel = "noopener";
    row.append(a);
    row.append(el("div", "muted", `${e.date}${e.time ? " " + e.time : ""} · ${e.venue}, ${e.town}`));
    host.append(row);
  });
}

function renderLinks() {
  const host = $("#links-body");
  SITE.links.forEach((l) => {
    const a = el("a", null, `${l.label} ↗`);
    a.href = l.url; a.target = "_blank"; a.rel = "noopener";
    host.append(a);
  });
}

// ---------------------------------------------------------------- photos

function uploadUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}/upload/${CONFIG.photoBranch}/${CONFIG.photoDir}`;
}

async function renderPhotos() {
  const hint = $("#photos-hint");
  const host = $("#photos-body");
  const [owner, repo] = CONFIG.photoRepo.split("/");
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${CONFIG.photoDir}?ref=${CONFIG.photoBranch}`;

  let files = [];
  try {
    const r = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    files = (await r.json()).filter((f) => f.type === "file" && IMG_RE.test(f.name));
  } catch (e) {
    hint.textContent = `Could not load photos (${e.message}).`;
    return;
  }

  if (!files.length) {
    hint.innerHTML =
      `Nothing yet. <a href="${uploadUrl(owner, repo)}" target="_blank" rel="noopener">Upload a photo</a>, ` +
      `and it shows up here a minute or two later.`;
    return;
  }

  // Newest first, assuming the resize workflow's date-prefixed filenames.
  files.sort((a, b) => b.name.localeCompare(a.name));
  hint.innerHTML =
    `${files.length} photo${files.length === 1 ? "" : "s"} · ` +
    `<a href="${uploadUrl(owner, repo)}" target="_blank" rel="noopener">add more</a>`;

  files.forEach((f) => {
    const img = el("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = `${CONFIG.photoDir}/${encodeURIComponent(f.name)}`;
    img.alt = f.name;
    img.onclick = () => openLightbox(img.src);
    host.append(img);
  });
}

function openLightbox(src) {
  $("#lb-img").src = src;
  $("#lightbox").hidden = false;
}

// ---------------------------------------------------------------- unlock

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decryptPayload(blob, passphrase) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(blob.salt), iterations: blob.iters, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64(blob.iv) }, key, b64(blob.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------- render

function renderSite() {
  renderCountdown();
  renderItinerary();
  renderNow();
  renderLocTabs();
  renderIdeas();
  renderEvents();
  renderLinks();
  renderPhotos();

  $("#generated").textContent =
    "Updated " + new Date(SITE.generated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  document.querySelectorAll(".chips .chip").forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll(".chips .chip").forEach((x) => x.classList.remove("is-on"));
      c.classList.add("is-on");
      renderIdeas(c.dataset.filter);
    };
  });

  const lb = $("#lightbox");
  lb.onclick = () => { lb.hidden = true; };

  $("#lock").onclick = () => {
    sessionStorage.removeItem("trip-pass");
    location.reload();
  };

  $("#gate").hidden = true;
  $("#site").hidden = false;

  // Jump to today if it is one of the trip days.
  const t = document.getElementById(`d-${todayISO()}`);
  if (t && !location.hash) t.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------- boot

async function unlock(passphrase) {
  const blob = await (await fetch("data/site.enc.json", { cache: "no-cache" })).json();
  SITE = await decryptPayload(blob, passphrase); // throws on a wrong passphrase
  sessionStorage.setItem("trip-pass", passphrase);
  renderSite();
}

function wireGate() {
  const form = $("#gate-form");
  const btn = $("#gate-btn");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("#gate-error").hidden = true;
    btn.disabled = true;
    btn.textContent = "Unlocking...";
    try {
      await unlock($("#gate-input").value);
    } catch {
      $("#gate-error").hidden = false;
      $("#gate-input").select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  });
}

async function main() {
  wireGate();

  // Stay unlocked while the tab lives, so a refresh does not re-prompt.
  const saved = sessionStorage.getItem("trip-pass");
  if (saved) {
    try {
      await unlock(saved);
      return;
    } catch {
      sessionStorage.removeItem("trip-pass");
    }
  }
  $("#gate-input").focus();
}

main();
