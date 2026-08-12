#!/usr/bin/env python3
"""Exit 0 while the trip is on, 1 otherwise.

The workflow runs every three hours so the forecast stays fresh during the
trip. Outside it, that would rebuild and commit the payload eight times a day
forever, so the off-peak runs check here first and stop.

Deliberately stdlib only, with no import of build.py: this runs in a gate job
that skips the dependency install, so pulling in cryptography would break it.

Trip dates come from the itinerary sheet, so moving the trip needs no code
change. A network failure reports 'in the window' rather than skipping, since a
needless build is cheaper than a silently stale site.
"""

import csv
import io
import sys
import urllib.request
from datetime import date, datetime, timedelta

SHEET_ID = "16RxfeRHxWu3tie2SyiMKxWxSouBOHdeqBNXb_JxC5xA"
SHEET_GID = "1657451631"
UA = "hahndathils-trip-site (github.com/hahndathils)"
GRACE = timedelta(days=1)  # keep refreshing the day either side


def parse_date(raw):
    raw = (raw or "").strip()
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def main():
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export"
           f"?format=csv&gid={SHEET_GID}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read().decode("utf-8")
    except Exception as e:
        print(f"could not read the sheet ({e}), assuming the trip is on")
        return 0

    rows = csv.DictReader(io.StringIO(text))
    dates = sorted(d for d in (parse_date(r.get("Date")) for r in rows) if d)
    if not dates:
        print("no dates in the sheet, assuming the trip is on")
        return 0

    start, end = dates[0] - GRACE, dates[-1] + GRACE
    today = date.today()

    if start <= today <= end:
        print(f"{today} is inside {start}..{end}, building")
        return 0
    print(f"{today} is outside {start}..{end}, skipping")
    return 1


if __name__ == "__main__":
    sys.exit(main())
