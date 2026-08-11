# Hahndathils

Trip site for Ithaca and Cortland, NY. Static, hosted on GitHub Pages, no server.

## What it does

- **Itinerary** pulled live from the family Google Sheet on every build
- **7-day forecast** for Cortland, Ithaca, Lansing, and Montour Falls from the National Weather Service
- **Ideas** for filling gaps, filterable to indoor picks when it rains
- **Photos** uploaded straight to `photos/` through the GitHub web UI
- **Addresses** encrypted, revealed only to someone who types the passphrase

## How it updates

One workflow, `.github/workflows/build-and-deploy.yml`, runs on:

- a daily cron at 11:00 UTC (7am Eastern)
- any push to `main`, including photo uploads
- manual trigger from the Actions tab

It normalizes new photos, regenerates `data/`, commits anything that changed, and
deploys to Pages.

## Adding photos

Open `photos/` on GitHub, hit **Add file > Upload files**, pick images, commit.
Works from a phone browser. The GitHub mobile app cannot upload files.

The workflow then converts HEIC to JPEG, downscales to 1600px, strips EXIF
(including GPS), and renames to `<timestamp>-<name>.jpg`. Already-processed files
are listed in `photos/.processed.json` and skipped on later runs.

## Privacy model

The whole site sits behind one passphrase. `data/site.enc.json` holds the entire
payload (itinerary, addresses, weather, ideas, links) encrypted with AES-GCM
under a key derived from `TRIP_PASSPHRASE` via PBKDF2-SHA256 at 600,000
iterations. The page renders nothing until the browser derives the same key with
WebCrypto and decrypts it.

Know what this does not cover:

- **Photos in `photos/` are public files.** The gallery only appears after
  unlocking, but the JPEGs themselves are fetchable by direct URL, in the repo
  and on the Pages site. Nothing protects them.
- **The repo is public.** `index.html`, `assets/`, `scripts/`, `ideas.json`, and
  the full git history are readable by anyone.
- **The ciphertext is downloadable**, so it can be attacked offline at an
  attacker's own pace. The passphrase is the entire defense. Use several random
  words.

Truly gating the photos needs a server checking a cookie, which GitHub Pages
cannot do. That means Cloudflare Access or a Worker in front of the assets.
Note that a private repo does not solve it either: private Pages access control
is GitHub Enterprise only, so on Pro a private repo still publishes a public
site.

## Local development

```sh
pip install cryptography Pillow pillow-heif
TRIP_PASSPHRASE='whatever' python scripts/build.py
python -m http.server 8000
```

Then open http://localhost:8000. WebCrypto needs a secure context, which
`localhost` counts as, so the unlock button works locally too.

## Editing content

| What | Where |
| --- | --- |
| Itinerary | the Google Sheet, `SHEET_ID` in `scripts/build.py` |
| Ideas list | `scripts/ideas.json` |
| Forecast locations | `LOCATIONS` in `scripts/build.py` |

## Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `TRIP_PASSPHRASE` | yes | encrypts the whole payload; the build fails without it |
| `TICKETMASTER_KEY` | no | adds real concert and show listings within 35 miles |
