#!/usr/bin/env python3
"""Build data/site.json, the whole payload the page renders.

Sources:
  - itinerary: Google Sheet, exported as CSV
  - the stay:  second tab of the same sheet
  - weather:   api.weather.gov (no key needed)
  - events:    scripts/events.json, plus Ticketmaster if TICKETMASTER_KEY is set
  - ideas:     scripts/ideas.json (hand-curated)
  - quotes:    one JSON file each under quotes/

Everything here is public. The site has no passphrase, so this payload, the
photos, and the Airbnb details including the lockbox code are readable by
anyone with the URL.
"""

import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SHEET_ID = "16RxfeRHxWu3tie2SyiMKxWxSouBOHdeqBNXb_JxC5xA"
SHEET_GID = "1657451631"   # itinerary tab
STAY_GID = "0"             # Airbnb details tab

UA = "hahndathils-trip-site (github.com/hahndathils)"

# Resolved once from api.weather.gov/points/{lat},{lon}; all four sit in the
# Binghamton (BGM) forecast office.
LOCATIONS = [
    {"key": "cortland", "label": "Cortland", "grid": "BGM/54,79", "lat": 42.6012, "lon": -76.1805},
    {"key": "ithaca", "label": "Ithaca", "grid": "BGM/44,70", "lat": 42.4440, "lon": -76.5019},
]

# Which forecast covers an itinerary stop. Lansing and Montour Falls are both
# closer to Ithaca than Cortland, and inside the same forecast zone, so they
# borrow Ithaca rather than carrying their own column.
TOWN_TO_LOC = [
    ("ithaca", ("ithaca", "lansing", "myers", "montour")),
    ("cortland", ("cortland",)),
]


def get(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url, **kw):
    return json.loads(get(url, **kw))


# --------------------------------------------------------------------------
# itinerary
# --------------------------------------------------------------------------

def parse_time(raw):
    """'4:00 PM' -> ('16:00', '4:00 PM'). Returns (None, '') if unparseable."""
    raw = (raw or "").strip()
    if not raw:
        return None, ""
    for fmt in ("%I:%M %p", "%I %p", "%H:%M"):
        try:
            t = datetime.strptime(raw, fmt)
            return t.strftime("%H:%M"), t.strftime("%-I:%M %p")
        except ValueError:
            continue
    return None, raw


def parse_date(raw):
    raw = (raw or "").strip()
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def split_location(loc):
    """'2016 Alpha Circle, Cortland, NY 13045' -> ('Cortland', 'NY').

    The sheet is inconsistent ('Myers Park, #1 Lansing, NY US 14882'), so this
    stays forgiving and falls back to the whole string.
    """
    loc = (loc or "").strip()
    if not loc:
        return "", ""
    parts = [p.strip() for p in loc.split(",") if p.strip()]
    if len(parts) < 2:
        return parts[0] if parts else "", ""
    tail = parts[-1]
    state = ""
    m = re.search(r"\b([A-Z]{2})\b", tail)
    if m:
        state = m.group(1)
    town = parts[-2]
    town = re.sub(r"^#?\d+\s+", "", town).strip()  # '#1 Lansing' -> 'Lansing'
    return town, state


def loc_key_for(town, location, activity=""):
    """Several sheet rows have no Location, so fall back to the activity text."""
    hay = f"{town} {location} {activity}".lower()
    for key, needles in TOWN_TO_LOC:
        if any(n in hay for n in needles):
            return key
    return "cortland"


def is_private_link(url):
    return "airbnb." in (url or "").lower()


def fetch_itinerary():
    rows = list(csv.DictReader(io.StringIO(sheet_csv(SHEET_GID))))

    items, links = [], []
    in_notes = False

    for row in rows:
        order = (row.get("Order") or "").strip()
        activity = (row.get("Activity") or "").strip()
        notes = (row.get("Options/Notes") or "").strip()

        # Everything past the 'Miscellaneous / Notes:' marker is a link list,
        # where the note column holds the URL.
        if order.lower().startswith("miscellaneous"):
            in_notes = True
            continue
        if in_notes:
            if order and notes.startswith("http"):
                links.append({"label": order, "url": notes})
            continue

        date = parse_date(row.get("Date"))
        if not activity or not date:
            continue  # blank spacer rows

        hhmm, label = parse_time(row.get("Time"))
        location = (row.get("Location") or "").strip()
        town, state = split_location(location)
        raw_link = (row.get("Link") or "").strip()

        item_id = hashlib.sha1(
            f"{date}|{hhmm}|{activity}".encode("utf-8")
        ).hexdigest()[:10]

        # Short notes are things like "35 mins from Airbnb" or "Option 1", which
        # are worth seeing without tapping. Long ones stay behind a toggle.
        one_line = "\n" not in notes and len(notes) <= 45
        hint = notes if one_line else ""

        items.append({
            "id": item_id,
            "date": date,
            "time": hhmm,
            "timeLabel": label,
            "activity": activity,
            "type": (row.get("Type") or "").strip(),
            "hint": hint,
            "notes": "" if one_line else notes,
            "town": ", ".join(x for x in (town, state) if x),
            "wx": loc_key_for(town, location, activity),
            # Public link only. Airbnb URL is held back for the encrypted blob.
            "link": "" if is_private_link(raw_link) else raw_link,
            "hasPrivate": bool(location or is_private_link(raw_link)),
            "_location": location,
            "_privateLink": raw_link if is_private_link(raw_link) else "",
        })

    items = apply_overrides(items)
    items.extend(extra_stops(items))
    items.sort(key=lambda i: (i["date"], i["time"] or "99:99"))
    return items, links


def apply_overrides(items):
    """Drop or edit sheet rows, per scripts/hidden_stops.json.

    The sheet is read-only from here, so plans that change mid-trip need a way
    to be adjusted without editing the source. Matching is a case-insensitive
    substring of the activity, scoped to one date, because several activities
    span multiple lines.

    Rule kinds, all scoped to a date:
      match   hide the whole stop
      strip   keep the stop, drop only the lines containing this text
      rename  keep the stop and replace fields on it:
                "to"       new activity text
                "location" new address, which also moves the town and forecast
                "link"     new link, or "" to drop one that no longer applies
    """
    path = os.path.join(ROOT, "scripts", "hidden_stops.json")
    try:
        with open(path) as f:
            rules = json.load(f)
    except FileNotFoundError:
        return items
    except Exception as e:
        print(f"  ! could not read hidden_stops.json: {e}", file=sys.stderr)
        return items

    def matches(rule, item, key):
        needle = (rule.get(key) or "").strip().lower()
        return (needle
                and rule.get("date") == item["date"]
                and needle in item["activity"].lower())

    kept = []
    for item in items:
        hide = next((r for r in rules if matches(r, item, "match")), None)
        if hide:
            print(f"    hidden: {item['activity'].splitlines()[0]}"
                  f"  ({hide.get('why', 'no reason given')})")
            continue

        for rule in [r for r in rules if matches(r, item, "rename")]:
            if rule.get("to"):
                item["activity"] = rule["to"]
                print(f"    renamed to: {rule['to']}")

            if "location" in rule:
                loc = rule["location"].strip()
                town, state = split_location(loc)
                item["_location"] = loc
                item["town"] = ", ".join(x for x in (town, state) if x)
                # A new address can sit under a different forecast.
                item["wx"] = loc_key_for(town, loc, item["activity"])
                print(f"    moved to: {loc or '(no address)'}")

            if "link" in rule:
                item["link"] = rule["link"].strip()
                print(f"    link: {item['link'] or '(cleared)'}")

        for rule in [r for r in rules if matches(r, item, "strip")]:
            needle = rule["strip"].strip().lower()
            lines = [l for l in item["activity"].splitlines()
                     if needle not in l.lower()]
            if not lines:
                continue  # never strip a stop down to nothing
            item["activity"] = "\n".join(lines).strip()
            print(f"    stripped {rule['strip']!r} from: {item['activity']}")

        # The id derives from the activity text, so it follows any edit above.
        item["id"] = hashlib.sha1(
            f"{item['date']}|{item['time']}|{item['activity']}".encode("utf-8")
        ).hexdigest()[:10]

        kept.append(item)
    return kept


def build_item(date, hhmm, label, activity, type_, notes, location, raw_link):
    one_line = "\n" not in notes and len(notes) <= 45
    town, state = split_location(location)
    return {
        "id": hashlib.sha1(f"{date}|{hhmm}|{activity}".encode("utf-8")).hexdigest()[:10],
        "date": date,
        "time": hhmm,
        "timeLabel": label,
        "activity": activity,
        "type": type_,
        "hint": notes if one_line else "",
        "notes": "" if one_line else notes,
        "town": ", ".join(x for x in (town, state) if x),
        "wx": loc_key_for(town, location, activity),
        "link": "" if is_private_link(raw_link) else raw_link,
        "hasPrivate": bool(location or is_private_link(raw_link)),
        "_location": location,
        "_privateLink": raw_link if is_private_link(raw_link) else "",
    }


def extra_stops(existing):
    """Stops added from here rather than the sheet.

    The sheet stays the source of truth, but editing it from a phone mid-trip is
    awkward. Anything added to the sheet later with the same date, time, and
    activity wins, so putting a stop in both places will not duplicate it.
    """
    path = os.path.join(ROOT, "scripts", "extra_stops.json")
    try:
        with open(path) as f:
            rows = json.load(f)
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"  ! could not read extra_stops.json: {e}", file=sys.stderr)
        return []

    seen = {(i["date"], i["time"], i["activity"].strip().lower()) for i in existing}
    out = []
    for r in rows:
        date = parse_date(r.get("date"))
        activity = (r.get("activity") or "").strip()
        if not date or not activity:
            continue
        hhmm, label = parse_time(r.get("time"))
        if (date, hhmm, activity.lower()) in seen:
            print(f"    already in the sheet, skipping: {activity}")
            continue
        out.append(build_item(
            date, hhmm, label, activity,
            (r.get("type") or "").strip(),
            (r.get("notes") or "").strip(),
            (r.get("location") or "").strip(),
            (r.get("link") or "").strip(),
        ))
        print(f"    added from extra_stops.json: {activity}")
    return out


# --------------------------------------------------------------------------
# weather
# --------------------------------------------------------------------------

def slim_daily(p):
    return {
        "name": p["name"],
        "start": p["startTime"],
        "day": p["isDaytime"],
        "temp": p["temperature"],
        "pop": (p.get("probabilityOfPrecipitation") or {}).get("value") or 0,
        "wind": p.get("windSpeed", ""),
        "short": p.get("shortForecast", ""),
        "detail": p.get("detailedForecast", ""),
        "icon": p.get("icon", ""),
    }


def slim_hour(p):
    return {
        "start": p["startTime"],
        "temp": p["temperature"],
        "pop": (p.get("probabilityOfPrecipitation") or {}).get("value") or 0,
        "short": p.get("shortForecast", ""),
    }


def fetch_weather():
    out = {}
    for loc in LOCATIONS:
        base = f"https://api.weather.gov/gridpoints/{loc['grid']}"
        entry = {"label": loc["label"], "daily": [], "hourly": []}
        try:
            fc = get_json(f"{base}/forecast")
            entry["daily"] = [slim_daily(p) for p in fc["properties"]["periods"]]
        except Exception as e:
            print(f"  ! daily forecast failed for {loc['key']}: {e}", file=sys.stderr)
        try:
            hr = get_json(f"{base}/forecast/hourly")
            cutoff = datetime.now(timezone.utc) + timedelta(days=7)
            for p in hr["properties"]["periods"]:
                t = datetime.fromisoformat(p["startTime"])
                if t > cutoff:
                    break
                if 6 <= t.hour <= 22:  # nobody is planning a 3am activity
                    entry["hourly"].append(slim_hour(p))
        except Exception as e:
            print(f"  ! hourly forecast failed for {loc['key']}: {e}", file=sys.stderr)
        out[loc["key"]] = entry
        print(f"  weather {loc['key']}: {len(entry['daily'])} periods, "
              f"{len(entry['hourly'])} hours")
    return out


# --------------------------------------------------------------------------
# events (optional)
# --------------------------------------------------------------------------

def curated_events(trip_end):
    """Hand-checked local listings from scripts/events.json.

    Ticketmaster only carries ticketed shows, which misses the things this area
    actually does on a summer weekend: porchfests, farmers markets, free concerts
    in a park. Those get listed by hand.
    """
    path = os.path.join(ROOT, "scripts", "events.json")
    try:
        with open(path) as f:
            events = json.load(f)
    except Exception as e:
        print(f"  ! could not read events.json: {e}", file=sys.stderr)
        return []

    today = datetime.now().date().isoformat()
    horizon = max(trip_end or today,
                  (datetime.now() + timedelta(days=7)).date().isoformat())

    keep, adult = [], []
    for e in events:
        if not (today <= e.get("date", "") <= horizon):
            continue
        # This is a family trip with young kids, so late ticketed shows and
        # anything age-restricted stays off the list. Flag them in events.json.
        (adult if e.get("adults") else keep).append(e)

    print(f"  curated events: {len(keep)} inside the window")
    for e in adult:
        print(f"    skipped (adults): {e['name']}")
    return keep


def fetch_events():
    key = os.environ.get("TICKETMASTER_KEY", "").strip()
    if not key:
        print("  ticketmaster: no key, skipping")
        return []
    now = datetime.now(timezone.utc)
    params = urllib.parse.urlencode({
        "apikey": key,
        "latlong": "42.5,-76.4",
        "radius": "35",
        "unit": "miles",
        "startDateTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endDateTime": (now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "size": "40",
        "sort": "date,asc",
    })
    try:
        d = get_json(f"https://app.ticketmaster.com/discovery/v2/events.json?{params}")
    except Exception as e:
        print(f"  ! ticketmaster failed: {e}", file=sys.stderr)
        return []
    events = []
    for e in d.get("_embedded", {}).get("events", []):
        venues = e.get("_embedded", {}).get("venues", [])
        venue = venues[0] if venues else {}
        events.append({
            "name": e.get("name", ""),
            "date": (e.get("dates", {}).get("start", {}) or {}).get("localDate", ""),
            "time": (e.get("dates", {}).get("start", {}) or {}).get("localTime", ""),
            "venue": venue.get("name", ""),
            "town": (venue.get("city") or {}).get("name", ""),
            "url": e.get("url", ""),
        })
    print(f"  events: {len(events)}")
    return events


# --------------------------------------------------------------------------
# the stay
# --------------------------------------------------------------------------

def sheet_csv(gid):
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export"
           f"?format=csv&gid={gid}")
    return get(url).decode("utf-8")


def fetch_stay():
    """Airbnb tab: two columns of 'LABEL:' and a possibly multi-line value.

    Door code and host phone live here, which is the argument for keeping the
    site behind its passphrase.
    """
    try:
        rows = list(csv.reader(io.StringIO(sheet_csv(STAY_GID))))
    except Exception as e:
        print(f"  ! could not read the stay tab: {e}", file=sys.stderr)
        return []

    out = []
    for row in rows:
        label = (row[0] if row else "").strip().rstrip(":").strip()
        value = (row[1] if len(row) > 1 else "").strip()
        if not label or not value:
            continue
        out.append({
            "label": label.title(),
            "value": value,
            "url": value if value.startswith("http") else "",
            # Long blocks like the checkout chores collapse behind a toggle.
            "long": len(value) > 120,
        })
    print(f"  {len(out)} stay details")
    return out


# --------------------------------------------------------------------------
# quotes
# --------------------------------------------------------------------------

def load_quotes():
    """Funny things people said, one JSON file each under quotes/.

    A file per quote rather than one growing array: two people adding at the
    same moment would otherwise need a read, merge, and write against a branch
    that is moving under them.
    """
    folder = os.path.join(ROOT, "quotes")
    out = []
    try:
        names = sorted(os.listdir(folder))
    except FileNotFoundError:
        return out

    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, name)) as f:
                q = json.load(f)
        except Exception as e:
            print(f"  ! skipping {name}: {e}", file=sys.stderr)
            continue
        if q.get("text"):
            out.append({
                "text": q["text"],
                "who": q.get("who", ""),
                "when": q.get("when", ""),
                "added": q.get("added", ""),
            })

    out.sort(key=lambda q: q.get("added", ""), reverse=True)
    print(f"  {len(out)} quotes")
    return out


# --------------------------------------------------------------------------
# photos
# --------------------------------------------------------------------------

PHOTO_RE = re.compile(r"\.(jpe?g|png|gif|webp|avif)$", re.I)


def list_photos():
    """Inventory photos/ so the page never has to call the GitHub API.

    Unauthenticated GitHub allows 60 requests per hour per IP. A houseful of
    people on one wifi shares that, and each page load would spend one, so the
    gallery would start 403ing partway through the trip. Uploads trigger a
    build anyway, so this list is never more than a build behind.
    """
    photo_dir = os.path.join(ROOT, "photos")
    try:
        names = [n for n in os.listdir(photo_dir) if PHOTO_RE.search(n)]
    except FileNotFoundError:
        return []
    names.sort(reverse=True)  # filenames are timestamped, so this is newest first
    print(f"  {len(names)} photos")
    return names


# --------------------------------------------------------------------------
# ideas
# --------------------------------------------------------------------------

# Words too generic to identify a place on their own. Without this,
# "Cortland Beer Company" would match the itinerary's "Ithaca Beer Company".
IDEA_STOPWORDS = {
    "the", "of", "and", "at", "a", "an", "state", "park", "trail", "co",
    "annual", "st", "nature",
}

# A single word is not enough to identify a place. "Center Ithaca" reduces to
# just "ithaca" once stopwords go, and that appears in nearly every stop, so it
# matched everything and hid the idea whether or not it was actually planned.
MIN_IDEA_TOKENS = 2


def significant(name):
    words = re.findall(r"[a-z0-9]+", name.lower())
    return [w for w in words if w not in IDEA_STOPWORDS]


def prune_ideas(ideas, items):
    """Drop suggestions for places already on the itinerary.

    An idea counts as a duplicate when every distinctive word of its name (or of
    one side of a 'X / Y' name) shows up in a single itinerary entry. Requiring
    all of them keeps near-misses like Cortland Beer vs Ithaca Beer separate.
    """
    haystacks = [
        f"{i['activity']} {i['hint']} {i['notes']} {i['_location']}".lower()
        for i in items
    ]

    def already_planned(idea):
        for variant in idea["name"].split("/"):
            tokens = significant(variant)
            if len(tokens) < MIN_IDEA_TOKENS:
                continue
            if any(all(t in hay for t in tokens) for hay in haystacks):
                return True
        return False

    kept, dropped = [], []
    for idea in ideas:
        (dropped if already_planned(idea) else kept).append(idea)

    if dropped:
        print(f"  dropped {len(dropped)} ideas already on the itinerary:")
        for idea in dropped:
            print(f"    - {idea['name']}")
    return kept


# --------------------------------------------------------------------------
# cache busting
# --------------------------------------------------------------------------

ASSET_RE = re.compile(r'(assets/(?:app\.js|style\.css))(\?v=[0-9a-f]+)?')


def digest(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]


def version_imports():
    """Stamp modules that app.js imports, which index.html never mentions.

    The service worker caches /assets/ cache-first, so an unversioned import
    would be pinned forever on a device that already has it. Runs before the
    index.html pass, since changing app.js changes its own hash.
    """
    app_path = os.path.join(ROOT, "assets", "app.js")
    with open(app_path) as f:
        src = f.read()

    updated = re.sub(
        r'(\./sparkle\.js)(\?v=[0-9a-f]+)?',
        lambda m: f"./sparkle.js?v={digest('assets/sparkle.js')}",
        src,
    )
    if updated != src:
        with open(app_path, "w") as f:
            f.write(updated)
        print("  stamped module imports in app.js")


def version_assets():
    """Stamp a content hash onto the asset URLs in index.html.

    GitHub Pages serves these with a 10 minute max-age and no way to override
    it, so without a changing query string phones sit on a stale app.js long
    after a deploy. The hash only moves when the file's bytes move, so this is
    idempotent and does not churn the diff on unrelated builds.
    """
    version_imports()
    html_path = os.path.join(ROOT, "index.html")
    with open(html_path) as f:
        html = f.read()

    def stamp(m):
        rel = m.group(1)
        return f"{rel}?v={digest(rel)}"

    updated = ASSET_RE.sub(stamp, html)
    if updated != html:
        with open(html_path, "w") as f:
            f.write(updated)
        print("  stamped asset versions into index.html")
    else:
        print("  asset versions already current")


# --------------------------------------------------------------------------

def main():
    os.makedirs(DATA, exist_ok=True)

    print("itinerary...")
    items, links = fetch_itinerary()
    print(f"  {len(items)} stops, {len(links)} reference links")

    print("weather...")
    weather = fetch_weather()

    dates = sorted({i["date"] for i in items})

    print("events...")
    events = curated_events(dates[-1] if dates else None) + fetch_events()
    events.sort(key=lambda e: (e.get("date", ""), e.get("time", "")))

    print("ideas...")
    with open(os.path.join(ROOT, "scripts", "ideas.json")) as f:
        ideas = prune_ideas(json.load(f), items)
    print(f"  {len(ideas)} suggestions remain")

    print("photos...")
    photos = list_photos()

    print("the stay...")
    stay = fetch_stay()

    print("quotes...")
    quotes = load_quotes()

    stops = []
    for i in items:
        stop = {k: v for k, v in i.items() if not k.startswith("_")}
        # Now that the whole payload is encrypted, the address and the booking
        # link ride along with everything else instead of in a second blob.
        stop["address"] = i["_location"]
        stop["privateLink"] = i["_privateLink"]
        stops.append(stop)

    site = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trip": {"start": dates[0] if dates else None,
                 "end": dates[-1] if dates else None},
        "locations": [{"key": l["key"], "label": l["label"]} for l in LOCATIONS],
        "itinerary": stops,
        "weather": weather,
        "events": events,
        "ideas": ideas,
        "links": links,
        "photos": photos,
        "stay": stay,
        "quotes": quotes,
    }

    out = os.path.join(DATA, "site.json")
    with open(out, "w") as f:
        json.dump(site, f, separators=(",", ":"))
    print(f"  wrote site.json ({os.path.getsize(out) // 1024} KB)")

    version_assets()

    # Left over from when the payload was encrypted.
    for stale in ("site.enc.json", "private.enc.json"):
        p = os.path.join(DATA, stale)
        if os.path.exists(p):
            os.remove(p)
            print(f"  removed stale {stale}")


if __name__ == "__main__":
    main()
