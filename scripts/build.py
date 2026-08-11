#!/usr/bin/env python3
"""Build data/site.enc.json: the entire site payload under one passphrase.

Sources:
  - itinerary: Google Sheet, exported as CSV
  - weather:   api.weather.gov (no key needed)
  - events:    Ticketmaster Discovery API (optional, needs TICKETMASTER_KEY)
  - ideas:     scripts/ideas.json (hand-curated)

Nothing readable ships in the clear. The whole payload is encrypted with AES-GCM
under a key derived from TRIP_PASSPHRASE, and the browser decrypts it only after
someone types the passphrase.

Files under photos/ are NOT covered by this. They are ordinary files in a public
repo, reachable by direct URL whether or not the page has been unlocked.
"""

import base64
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

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

SHEET_ID = "16RxfeRHxWu3tie2SyiMKxWxSouBOHdeqBNXb_JxC5xA"
SHEET_GID = "1657451631"

UA = "hahndathils-trip-site (github.com/hahndathils)"
PBKDF2_ITERS = 600_000

# Resolved once from api.weather.gov/points/{lat},{lon}; all four sit in the
# Binghamton (BGM) forecast office.
LOCATIONS = [
    {"key": "cortland", "label": "Cortland", "grid": "BGM/54,79", "lat": 42.6012, "lon": -76.1805},
    {"key": "ithaca", "label": "Ithaca", "grid": "BGM/44,70", "lat": 42.4440, "lon": -76.5019},
    {"key": "lansing", "label": "Lansing", "grid": "BGM/42,75", "lat": 42.5545, "lon": -76.5522},
    {"key": "montour", "label": "Montour Falls", "grid": "BGM/33,64", "lat": 42.3462, "lon": -76.8438},
]

# Which forecast location best covers an itinerary stop.
TOWN_TO_LOC = [
    ("montour", ("montour",)),
    ("lansing", ("lansing", "myers")),
    ("ithaca", ("ithaca",)),
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
    url = (
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export"
        f"?format=csv&gid={SHEET_GID}"
    )
    text = get(url).decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))

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

        items.append({
            "id": item_id,
            "date": date,
            "time": hhmm,
            "timeLabel": label,
            "activity": activity,
            "type": (row.get("Type") or "").strip(),
            "notes": notes,
            "town": ", ".join(x for x in (town, state) if x),
            "wx": loc_key_for(town, location, activity),
            # Public link only. Airbnb URL is held back for the encrypted blob.
            "link": "" if is_private_link(raw_link) else raw_link,
            "hasPrivate": bool(location or is_private_link(raw_link)),
            "_location": location,
            "_privateLink": raw_link if is_private_link(raw_link) else "",
        })

    items.sort(key=lambda i: (i["date"], i["time"] or "99:99"))
    return items, links


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

def fetch_events():
    key = os.environ.get("TICKETMASTER_KEY", "").strip()
    if not key:
        print("  events: no TICKETMASTER_KEY, skipping")
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
# encryption
# --------------------------------------------------------------------------

def existing_salt(path):
    """Reuse the salt across runs so only the ciphertext churns, not the KDF."""
    try:
        with open(path) as f:
            return base64.b64decode(json.load(f)["salt"])
    except Exception:
        return None


def write_encrypted(payload, passphrase, path):
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    salt = existing_salt(path) or os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt,
                              PBKDF2_ITERS, dklen=32)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext, None)

    with open(path, "w") as f:
        json.dump({
            "v": 1,
            "kdf": "PBKDF2-SHA256",
            "iters": PBKDF2_ITERS,
            "salt": base64.b64encode(salt).decode(),
            "iv": base64.b64encode(iv).decode(),
            "ct": base64.b64encode(ct).decode(),
        }, f, indent=1)
    kb = os.path.getsize(path) // 1024
    print(f"  encrypted {len(plaintext)} bytes -> {os.path.basename(path)} ({kb} KB)")


# --------------------------------------------------------------------------

def main():
    passphrase = os.environ.get("TRIP_PASSPHRASE", "").strip()
    if not passphrase:
        sys.exit("TRIP_PASSPHRASE is not set. Refusing to build without it "
                 "(the whole payload would ship unencrypted).")

    os.makedirs(DATA, exist_ok=True)

    print("itinerary...")
    items, links = fetch_itinerary()
    print(f"  {len(items)} stops, {len(links)} reference links")

    print("weather...")
    weather = fetch_weather()

    print("events...")
    events = fetch_events()

    with open(os.path.join(ROOT, "scripts", "ideas.json")) as f:
        ideas = json.load(f)

    dates = sorted({i["date"] for i in items})
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
    }

    write_encrypted(site, passphrase, os.path.join(DATA, "site.enc.json"))

    # Anything left from the old split-payload layout would still be readable.
    for stale in ("site.json", "private.enc.json"):
        p = os.path.join(DATA, stale)
        if os.path.exists(p):
            os.remove(p)
            print(f"  removed stale {stale}")


if __name__ == "__main__":
    main()
