// Hahndathils trip site. No framework, no build step.
// Renders data/site.json. Everything on this site is public.

import { initSparkles } from "./sparkle.js?v=211e46b1";

const CONFIG = {
  photoDir: "photos",
  // Cloudflare Worker that accepts uploads and commits them to the repo, so
  // nobody needs a GitHub account. Empty string hides the upload button.
  uploadUrl: "https://hahndathils-upload.frugalhahns.workers.dev/upload",
  // Public by definition: this ships in the page source. It only stops random
  // scanners from posting to the endpoint, and can be rotated on its own.
  uploadToken: "hahndathils-2026-tetherball",
  maxEdge: 1600,
  jpegQuality: 0.82,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let SITE = null;      // the whole payload, fetched at load
let PHOTOS = [];      // image URLs, in gallery order
let LB_INDEX = 0;     // which one the lightbox is showing

// ---------------------------------------------------------------- helpers

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

// '19:00' -> '7:00 PM'
function parseTimeLabel(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

function directionsUrl(from, to) {
  return "https://www.google.com/maps/dir/?api=1" +
    `&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`;
}

function renderStop(stop, prev) {
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

  // Route from wherever you just were, rather than from wherever the phone
  // thinks you are.
  if (prev?.address && stop.address && prev.address !== stop.address) {
    const a = el("a", null, "directions ↗");
    a.href = directionsUrl(prev.address, stop.address);
    a.target = "_blank";
    a.rel = "noopener";
    meta.append(a);
  }
  body.append(meta);

  // "35 mins from Airbnb", "Option 1". Short enough to read in place.
  if (stop.hint) body.append(el("div", "stop-hint", stop.hint));

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

/* Two top-level views, switched from the floating bar at the bottom of the
   screen. Stay takes over the itinerary area rather than sitting under it, and
   hides the day tabs, which mean nothing while you are reading a door code. */
function setView(view) {
  const staying = view === "stay";
  const quoting = view === "quotes";
  const album = view === "album";
  const trip = !staying && !quoting && !album;

  $("#stay").hidden = !staying;
  $("#quotes").hidden = !quoting;
  $("#album").hidden = !album;
  $("#days").hidden = !trip;
  $("#daynav").hidden = !trip;
  $("#itinerary-title").textContent =
    staying ? "Where we're staying"
      : quoting ? "Things we said"
      : album ? `Every photo (${PHOTOS.length})`
      : "Flexible itinerary";

  // The rest of the page is about the trip, so it only belongs on that view.
  ["#now", "#photos", "#forecast", "#ideas"].forEach((sel) => {
    const n = $(sel);
    // Never unhide the now card if it never got any content.
    if (n) n.hidden = !trip || (sel === "#now" && !n.children.length);
  });

  document.querySelectorAll("#viewbar button").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
  });

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* Every photo at once, grouped by the day it was taken. The carousel is good
   for a glance; this is for actually looking through them afterwards.

   Indices match PHOTOS, so the lightbox and its prev/next work unchanged. */
function renderAlbum() {
  const host = $("#album");
  host.innerHTML = "";
  if (!PHOTOS.length) {
    host.append(el("p", "muted", "No photos yet."));
    return;
  }

  const names = SITE.photos || [];
  let lastDay = null;

  PHOTOS.forEach((src, i) => {
    // photo-20260814-122242-xxxxxx.jpg
    const stamp = (names[i] || "").match(/^photo-(\d{4})(\d{2})(\d{2})/);
    const day = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}` : "";

    if (day !== lastDay) {
      lastDay = day;
      host.append(el("h3", "album-day", day ? dayName(day) : "Undated"));
      host.append(el("div", "album-grid"));
    }

    const img = el("img");
    img.loading = i < 8 ? "eager" : "lazy";
    img.decoding = "async";
    img.src = src;
    img.alt = names[i] || "";
    img.onclick = () => openLightbox(i);
    host.lastElementChild.append(img);
  });
}

/* Funny things people said, newest first, grouped under whatever the person
   typed in the "when" box so old memories can sit alongside this trip. */
function renderQuotes() {
  const host = $("#quotes-list");
  host.innerHTML = "";
  const quotes = SITE.quotes || [];

  if (!quotes.length) {
    host.append(el("p", "muted", "Nothing yet. Add the first one above."));
    return;
  }

  let lastGroup = null;
  quotes.forEach((q) => {
    const group = q.when || (q.added ? new Date(q.added).getFullYear() : "");
    if (group && group !== lastGroup) {
      host.append(el("div", "quote-group", String(group)));
      lastGroup = group;
    }
    const card = el("blockquote", "quote");
    card.append(el("p", "quote-text", q.text));
    if (q.who) card.append(el("footer", "quote-who", q.who));
    host.append(card);
  });
}

function wireQuoteForm() {
  const form = $("#quote-form");
  const status = $("#quote-status");
  if (!CONFIG.uploadUrl) { form.hidden = true; return; }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = $("#q-text").value.trim();
    if (!text) return;

    const btn = $("#q-save");
    btn.disabled = true;
    btn.textContent = "Saving...";
    status.hidden = true;

    const quote = {
      text,
      who: $("#q-who").value.trim(),
      when: $("#q-when").value.trim(),
      added: new Date().toISOString(),
    };

    try {
      const res = await fetch(CONFIG.uploadUrl.replace(/\/upload$/, "/quote"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...quote, token: CONFIG.uploadToken }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `save failed (${res.status})`);
      }
      // Show it straight away; the build republishes it a minute or two later.
      SITE.quotes.unshift(quote);
      renderQuotes();
      form.reset();
      status.textContent = "Saved. Everyone sees it in a minute or two.";
      status.hidden = false;
    } catch (e) {
      status.textContent = `Could not save: ${e.message}`;
      status.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Add quote";
    }
  });
}

function wireViewBar() {
  const bar = $("#viewbar");
  bar.hidden = false;
  bar.querySelectorAll("button").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
  setView("trip");
}

/* Which day to open on: today if we are mid-trip, otherwise the next day
   coming up, otherwise everything (the trip is over, so it is a scrapbook). */
function defaultDay(dates) {
  const today = todayISO();
  if (dates.includes(today)) return today;
  return dates.find((d) => d > today) || "all";
}

function selectDay(value, { scroll = false } = {}) {
  document.querySelectorAll(".day").forEach((sec) => {
    sec.hidden = value !== "all" && sec.dataset.date !== value;
  });
  document.querySelectorAll("#daynav-inner button").forEach((b) => {
    const on = b.dataset.day === value;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
  });

  // Point the forecast at wherever that day is mostly spent, so it does not
  // sit on Cortland while you are reading about a day in Ithaca.
  if (value !== "all") {
    const stops = SITE.itinerary.filter((s) => s.date === value);
    const tally = {};
    stops.forEach((s) => { tally[s.wx] = (tally[s.wx] || 0) + 1; });
    const busiest = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (busiest) showForecastFor(busiest);
  }
  if (scroll) {
    // Land just under the sticky nav rather than at the very top of the page.
    const y = $("#itinerary").getBoundingClientRect().top + window.scrollY - 56;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }
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
    sec.dataset.date = date;

    const head = el("div", "day-head");
    head.append(el("h3", null, dayName(date)));
    if (date === today) head.append(el("span", "tag", "today"));

    const hi = dayHigh(date, stops[0].wx);
    if (hi) head.append(el("span", "day-wx", `${wxEmoji(hi.short)} ${hi.temp}°F · ${hi.pop}% precip`));
    sec.append(head);

    stops.forEach((s, i) => sec.append(renderStop(s, stops[i - 1])));

    const events = dayEvents(date);
    if (events) sec.append(events);

    host.append(sec);
  });

  dates.forEach((date) => {
    const b = el("button");
    b.dataset.day = date;
    b.append(el("span", "nav-day", shortDay(date)));
    b.append(el("span", "nav-date", localDate(date).getDate()));
    if (date === today) b.classList.add("is-today");
    b.onclick = () => selectDay(date, { scroll: true });
    nav.append(b);
  });

  const all = el("button", "nav-wide", "All");
  all.dataset.day = "all";
  all.setAttribute("aria-pressed", "false");
  all.onclick = () => selectDay("all", { scroll: true });
  nav.append(all);

  selectDay(defaultDay(dates));
}

// ---------------------------------------------------------------- forecast

function renderForecast(locKey) {
  const host = $("#forecast-body");
  host.innerHTML = "";
  const all = SITE.weather[locKey]?.daily || [];
  const nights = all.filter((p) => !p.day);

  // Days past the drive home are noise while the trip is still on.
  const end = SITE.trip.end;
  const tripStillOn = end && todayISO() <= end;
  const periods = all
    .filter((p) => p.day)
    .filter((p) => !tripStillOn || p.start.slice(0, 10) <= end);

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

function showForecastFor(locKey) {
  const tabs = $("#loc-tabs");
  let found = false;
  tabs.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.loc === locKey;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
    if (on) found = true;
  });
  if (found) renderForecast(locKey);
}

function renderLocTabs() {
  const tabs = $("#loc-tabs");
  SITE.locations.forEach((loc) => {
    const b = el("button", null, loc.label);
    b.dataset.loc = loc.key;
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => showForecastFor(loc.key);
    tabs.append(b);
  });
  showForecastFor(SITE.locations[0].key);
}

// ---------------------------------------------------------------- ideas

function renderIdeas(filter = "all") {
  const host = $("#ideas-body");
  host.innerHTML = "";
  $("#ideas-count").textContent = `${SITE.ideas.length} ideas`;
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

function eventRow(e, { showDay = false } = {}) {
  const row = el("div", "event");
  const a = el("a", null, e.name);
  a.href = e.url; a.target = "_blank"; a.rel = "noopener";
  row.append(a);

  const bits = [];
  if (showDay) {
    bits.push(localDate(e.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
  }
  if (e.time) bits.push(parseTimeLabel(e.time));
  if (e.venue) bits.push(e.venue + (e.town && !e.venue.includes(e.town) ? ", " + e.town : ""));
  row.append(el("div", "muted", bits.join(" · ")));

  if (e.note) row.append(el("div", "event-note", e.note));
  return row;
}

/* Events sit inside the day they happen rather than in one long block, so the
   day filter narrows them for free and nothing competes with the itinerary. */
function dayEvents(date) {
  const events = SITE.events.filter((e) => e.date === date);
  if (!events.length) return null;

  const box = el("details", "day-events");
  const summary = el("summary");
  summary.append(el("span", "disclosure-title",
    `Also happening ${localDate(date).toLocaleDateString(undefined, { weekday: "long" })}`));
  summary.append(el("span", "disclosure-count",
    `${events.length} event${events.length === 1 ? "" : "s"}`));
  summary.append(el("span", "disclosure-action"));
  box.append(summary);

  const body = el("div", "disclosure-body");
  events.forEach((e) => body.append(eventRow(e)));
  box.append(body);
  return box;
}

/* Anything outside the trip dates still deserves a home. */
function renderEvents() {
  const dates = new Set(SITE.itinerary.map((s) => s.date));
  const leftover = SITE.events.filter((e) => !dates.has(e.date));
  if (!leftover.length) return;

  const host = $("#events-leftover");
  const box = el("details", "disclosure");
  const summary = el("summary");
  summary.append(el("span", "disclosure-title", "Happening nearby this week"));
  summary.append(el("span", "disclosure-count",
    `${leftover.length} event${leftover.length === 1 ? "" : "s"}`));
  summary.append(el("span", "disclosure-action"));
  box.append(summary);

  const body = el("div", "disclosure-body");
  leftover.forEach((e) => body.append(eventRow(e, { showDay: true })));
  box.append(body);
  host.append(box);
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

/* The photo list rides in the payload rather than coming from the GitHub API.
   Unauthenticated GitHub allows 60 requests an hour per IP, which a houseful of
   people on one wifi would burn through, and the gallery would start failing
   mid-trip. Uploads trigger a rebuild, so this list stays current. */
function renderPhotos() {
  const hint = $("#photos-hint");
  const host = $("#photos-body");
  const names = SITE.photos || [];

  if (!names.length) {
    hint.hidden = true;
    return;
  }
  hint.textContent = `${names.length} photo${names.length === 1 ? "" : "s"}`;

  PHOTOS = names.map((n) => `${CONFIG.photoDir}/${encodeURIComponent(n)}`);

  PHOTOS.forEach((src, i) => {
    const img = el("img");
    img.loading = i < 3 ? "eager" : "lazy";
    img.decoding = "async";
    img.src = src;
    img.alt = names[i];
    img.onclick = () => openLightbox(i);
    host.append(img);
  });

  $("#ph-all").hidden = false;
  $("#ph-all").onclick = () => setView("album");

  wireCarousel(host);
}

/* Airbnb details, straight from the second tab of the sheet. Door code and host
   number live here, which is the argument for the passphrase, and it is inside
   the offline payload so it works with no signal at the front door. */
function renderStay() {
  const rows = SITE.stay || [];
  const host = $("#stay");
  if (!rows.length) { host.innerHTML = ""; return; }

  rows.forEach((r) => {
    const box = el("div", "stay-row");
    box.append(el("div", "stay-label", r.label));

    if (r.url) {
      const a = el("a", "stay-value", "Open the listing ↗");
      a.href = r.url; a.target = "_blank"; a.rel = "noopener";
      box.append(a);
      host.append(box);
      return;
    }

    if (r.long) {
      const det = el("details", "disclosure");
      const sum = el("summary");
      sum.append(el("span", "disclosure-title", r.label));
      sum.append(el("span", "disclosure-action"));
      det.append(sum);
      const body = el("div", "disclosure-body");
      body.append(el("div", "stay-long", r.value));
      det.append(body);
      host.append(det);
      return;
    }

    const val = el("div", "stay-value", r.value);
    // Addresses get a map link; everything else stays selectable text.
    if (/address/i.test(r.label)) {
      val.textContent = "";
      const a = el("a", null, r.value);
      a.href = mapsUrl(r.value.replace(/\n/g, ", "));
      a.target = "_blank"; a.rel = "noopener";
      val.append(a);
    }
    box.append(val);
    host.append(box);
  });
}

// ---------------------------------------------------------------- uploading

/* Shrink in the browser before sending. Keeps the repo small, makes the upload
   fast on hotel wifi, and re-encoding as JPEG sidesteps HEIC, which only Safari
   can display. createImageBitmap applies the EXIF rotation, which matters
   because canvas would otherwise drop it and land everything sideways. */
async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, CONFIG.maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise((res) =>
    canvas.toBlob(res, "image/jpeg", CONFIG.jpegQuality)
  );
  if (!blob) throw new Error("could not read that image");
  return blob;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result).split(",")[1]);
    reader.onerror = () => rej(new Error("could not read file"));
    reader.readAsDataURL(blob);
  });
}

async function uploadOne(file) {
  const blob = await shrink(file);
  const res = await fetch(CONFIG.uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: CONFIG.uploadToken,
      taken: new Date(file.lastModified || Date.now()).toISOString(),
      data: await blobToBase64(blob),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `upload failed (${res.status})`);
  }
  return URL.createObjectURL(blob);
}

async function handleUpload(files) {
  const status = $("#ph-status");
  const track = $("#photos-body");
  let done = 0;
  const failures = [];
  status.hidden = false;

  for (const file of files) {
    status.textContent = `Uploading ${done + 1} of ${files.length}...`;
    try {
      const localUrl = await uploadOne(file);
      // Show it straight away. The real file lands in the gallery a minute or
      // two later once the build finishes, so this covers the gap.
      const img = el("img");
      img.src = localUrl;
      img.alt = file.name;
      PHOTOS.unshift(localUrl);
      track.prepend(img);
      img.onclick = () => openLightbox(PHOTOS.indexOf(localUrl));
      done++;
    } catch (e) {
      failures.push(`${file.name}: ${e.message}`);
    }
  }

  $("#photos-hint").hidden = done > 0;
  status.textContent = failures.length
    ? `Uploaded ${done}. Failed: ${failures.join("; ")}`
    : `Uploaded ${done} photo${done === 1 ? "" : "s"}. They appear for everyone in a minute or two.`;
}

function wireUpload() {
  const btn = $("#ph-add");
  const input = $("#ph-input");
  if (!CONFIG.uploadUrl) { btn.hidden = true; return; }

  btn.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files];
    input.value = ""; // let the same file be picked again after a failure
    if (!files.length) return;
    btn.disabled = true;
    try {
      await handleUpload(files);
    } finally {
      btn.disabled = false;
    }
  };
}

const DRIFT_SPEED = 55;        // px per second; a full pass takes ~30s on a phone
const DRIFT_RESUME_MS = 5000;  // stillness required before it picks back up

function wireCarousel(track) {
  const prev = $("#ph-prev");
  const next = $("#ph-next");
  const arrows = $("#ph-arrows");

  // scrollWidth forces layout, so measure on change rather than every frame.
  let room = 0;
  const measure = () => {
    room = track.scrollWidth - track.clientWidth;
    sync();
  };

  /* The gallery is built while #site is still hidden, where scrollWidth and
     clientWidth are both 0. Measuring only at setup would leave room at 0
     forever, so nothing would drift and the arrows would stay hidden. A
     ResizeObserver catches the moment it becomes visible, plus rotation and
     late-loading images. */
  new ResizeObserver(measure).observe(track);
  window.addEventListener("resize", measure);
  track.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", measure, { once: true });
  });

  // Declared before the reduced-motion bail below, so the arrow handlers can
  // call hold() without tripping over an uninitialised binding.
  let dir = 1;
  let last = 0;
  let paused = false;
  let timer = null;
  let pos = 0;

  function hold(ms = DRIFT_RESUME_MS) {
    paused = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      paused = false;
      last = 0;
      pos = track.scrollLeft;  // pick up wherever the swipe left off
    }, ms);
  }

  const scrollByCard = (d) => {
    const step = track.querySelector("img")?.getBoundingClientRect().width || 260;
    track.scrollBy({ left: d * (step + 10), behavior: "smooth" });
  };
  prev.onclick = () => { hold(); scrollByCard(-1); };
  next.onclick = () => { hold(); scrollByCard(1); };

  /* Only touch the DOM when a value actually changes. The drift fires a scroll
     event every frame, and reassigning .disabled each time invalidates style
     on both buttons 60 times a second, which is its own source of stutter. */
  let wasPrev = null;
  let wasNext = null;
  let wasHidden = null;
  const sync = () => {
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft >= room - 2;
    const noRoom = room <= 0;
    if (atStart !== wasPrev) { prev.disabled = atStart; wasPrev = atStart; }
    if (atEnd !== wasNext) { next.disabled = atEnd; wasNext = atEnd; }
    if (noRoom !== wasHidden) { arrows.hidden = noRoom; wasHidden = noRoom; }
  };
  track.addEventListener("scroll", sync, { passive: true });
  sync();

  // ---- slow drift ----
  // Reverses at each end rather than jumping back to the start, which would
  // read as a glitch. Never runs if the viewer asked for reduced motion.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  function step(ts) {
    requestAnimationFrame(step);

    // Idle while hidden, while the lightbox is up, or with nothing to scroll.
    if (paused || room <= 2 || document.hidden || !$("#lightbox").hidden) {
      last = ts;
      return;
    }
    const dt = last ? Math.min((ts - last) / 1000, 0.1) : 0;
    last = ts;

    /* pos is kept as a float here rather than read back from scrollLeft each
       frame. At this speed a frame advances well under a pixel, and browsers
       round scrollLeft on read, so round-tripping through the DOM would throw
       away the fraction every frame and nothing would ever move. */
    pos += dir * DRIFT_SPEED * dt;
    if (pos >= room) { pos = room; dir = -1; }
    else if (pos <= 0) { pos = 0; dir = 1; }
    track.scrollLeft = pos;
  }

  ["pointerdown", "touchstart", "wheel"].forEach((ev) =>
    track.addEventListener(ev, () => hold(), { passive: true })
  );
  track.addEventListener("mouseenter", () => { paused = true; clearTimeout(timer); });
  track.addEventListener("mouseleave", () => hold(600));

  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- lightbox

function openLightbox(i) {
  LB_INDEX = i;
  $("#lb-img").src = PHOTOS[i];
  $("#lb-count").textContent = `${i + 1} / ${PHOTOS.length}`;
  $("#lightbox").hidden = false;
}

function stepLightbox(delta) {
  if (!PHOTOS.length) return;
  openLightbox((LB_INDEX + delta + PHOTOS.length) % PHOTOS.length);
}

function wireLightbox() {
  const lb = $("#lightbox");

  // Clicking the backdrop closes; clicking a control or the photo does not.
  lb.onclick = (ev) => { if (ev.target === lb) lb.hidden = true; };
  $(".lb-close").onclick = () => { lb.hidden = true; };
  $("#lb-prev").onclick = () => stepLightbox(-1);
  $("#lb-next").onclick = () => stepLightbox(1);

  document.addEventListener("keydown", (ev) => {
    if (lb.hidden) return;
    if (ev.key === "Escape") lb.hidden = true;
    if (ev.key === "ArrowLeft") stepLightbox(-1);
    if (ev.key === "ArrowRight") stepLightbox(1);
  });

  let startX = null;
  lb.addEventListener("touchstart", (ev) => { startX = ev.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (ev) => {
    if (startX === null) return;
    const dx = ev.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 45) stepLightbox(dx < 0 ? 1 : -1);
    startX = null;
  }, { passive: true });
}

// ---------------------------------------------------------------- render

function renderSite() {
  // Mid-trip the header shrinks, because what matters then is the next stop,
  // not a countdown to a trip you are already on.
  const today = todayISO();
  if (SITE.trip.start && today >= SITE.trip.start && today <= SITE.trip.end) {
    document.body.classList.add("is-trip");
  }

  renderCountdown();
  renderLocTabs();   // before renderItinerary, which points the forecast at a day
  renderItinerary();
  renderNow();
  renderIdeas();
  renderEvents();
  renderLinks();
  renderStay();
  renderQuotes();
  wireQuoteForm();
  renderPhotos();   // populates PHOTOS, which the album and view bar both read
  renderAlbum();
  wireUpload();
  wireViewBar();
  startAutoRefresh();

  $("#generated").textContent =
    "Updated " + new Date(SITE.generated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  document.querySelectorAll(".chips .chip").forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll(".chips .chip").forEach((x) => x.classList.remove("is-on"));
      c.classList.add("is-on");
      renderIdeas(c.dataset.filter);
    };
  });

  wireLightbox();

}

// ---------------------------------------------------------------- boot

/* The now card is computed once at render, so an open tab would sit on the
   morning's hour all day. These keep it honest without a manual reload. */
const TICK_MS = 2 * 60 * 1000;      // recompute "up next" and the current hour
const REFETCH_MS = 30 * 60 * 1000;  // pull a newer payload if the build ran

let lastFetch = Date.now();

async function refreshPayload() {
  if (!SITE) return;
  try {
    const res = await fetch("data/site.json", { cache: "no-store" });
    if (!res.ok) return;
    const fresh = await res.json();
    lastFetch = Date.now();
    if (fresh.generated === SITE.generated) return;  // same build, nothing to do

    SITE = fresh;
    renderCountdown();
    renderNow();
    $("#generated").textContent =
      "Updated " + new Date(SITE.generated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    // Offline. The cached payload stays on screen.
  }
}

function startAutoRefresh() {
  setInterval(() => {
    renderCountdown();
    renderNow();
  }, TICK_MS);

  setInterval(refreshPayload, REFETCH_MS);

  // Coming back to a backgrounded tab is the case that matters most: the phone
  // was in a pocket for hours and the timers above were throttled or frozen.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    renderCountdown();
    renderNow();
    if (Date.now() - lastFetch > REFETCH_MS) refreshPayload();
  });
}

// ---------------------------------------------------------------- theme

/* Follows the device by default, and remembers an explicit choice. Applied from
   an inline script in the head as well, so the page never paints dark and then
   flips to light. */
const THEME_KEY = "theme";

function applyTheme(mode) {
  const light = mode === "light";
  document.documentElement.classList.remove("light-pending");
  document.body.classList.toggle("light", light);
  const btn = $("#theme-toggle");
  if (btn) {
    btn.textContent = light ? "☀️" : "🌙";
    btn.title = light ? "Switch to dark" : "Switch to light";
  }
  // Keeps the phone's status bar in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#f7f4ee" : "#12161b");
}

function currentTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function wireTheme() {
  applyTheme(currentTheme());
  $("#theme-toggle").onclick = () => {
    const next = document.body.classList.contains("light") ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  };
  // Follow the system only while the viewer has not picked a side.
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(currentTheme());
  });
}

/* Tells the Worker this browser opened the site. The result is visible only to
   the site owner at /seen/log; nothing about it is rendered here. The id is a
   random string with no connection to anything else, so it identifies a
   browser, not a person, until the owner labels it by hand. */
const DEVICE_KEY = "hahndathils-device";

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "");
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return ""; // private browsing blocks storage; skip rather than break
  }
}

function reportVisit() {
  if (!CONFIG.uploadUrl) return;
  const id = deviceId();
  if (!id) return;
  // keepalive so the request survives the page being closed straight away.
  fetch(CONFIG.uploadUrl.replace(/\/upload$/, "/seen"), {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: CONFIG.uploadToken,
      device: id,
      ref: document.referrer || "",
    }),
  }).catch(() => {}); // never let this surface to the viewer
}

/* Caches the shell up front so the site opens in a gorge with no signal. */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => {
      console.warn("offline support unavailable:", e.message);
    });
  });
}

async function main() {
  wireTheme();
  registerServiceWorker();
  reportVisit();
  initSparkles();

  const res = await fetch("data/site.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`could not load trip data (${res.status})`);
  SITE = await res.json();
  renderSite();
}

main().catch((e) => {
  document.querySelector("main").prepend(
    Object.assign(document.createElement("p"), {
      className: "error",
      textContent: e.message,
    })
  );
});
