# Hahndathils

Trip site for Ithaca and Cortland, NY. Static, hosted on GitHub Pages, no server.

## What it does

- **Itinerary** pulled live from the family Google Sheet on every build
- **7-day forecast** for Cortland, Ithaca, Lansing, and Montour Falls from the National Weather Service
- **Ideas** for filling gaps, filterable to indoor picks when it rains
- **Photos** uploaded straight to `photos/` through the GitHub web UI
- **Quotes** anyone can add, funny things said over the years

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

There isn't one. The site is public and so is the repo. The itinerary, the
Airbnb address, the host's phone number, and the lockbox code are all readable
by anyone with the URL, as are the photos and quotes. The page carries a
`noindex` header, which keeps it out of search results but does not restrict
access.

This was a deliberate choice. An earlier version encrypted the whole payload
behind a passphrase; it was removed because the friction was not worth it for a
family weekend.

## Local development

```sh
pip install Pillow pillow-heif
python scripts/build.py
python -m http.server 8000
```

Then open http://localhost:8000.

## Editing content

| What | Where |
| --- | --- |
| Itinerary | the Google Sheet, `SHEET_ID` in `scripts/build.py` |
| Ideas list | `scripts/ideas.json` |
| Forecast locations | `LOCATIONS` in `scripts/build.py` |

## Secrets

| Name | Where | Purpose |
| --- | --- | --- |
| `TICKETMASTER_KEY` | GitHub Actions | optional; adds ticketed shows within 35 miles |
| `GH_TOKEN` | Worker | fine-grained PAT, Contents read and write, this repo only |
| `UPLOAD_TOKEN` | Worker | must match `CONFIG.uploadToken` in `assets/app.js` |

## Photo uploads without a GitHub account

`worker/` holds a small Cloudflare Worker that accepts an upload from the site
and commits it to `photos/` using a token that never reaches the browser. The
site is static, so it cannot take a file POST on its own.

Flow: someone taps **+ Add photos**, the browser downscales to 1600px and
re-encodes as JPEG, the Worker checks the trip passphrase and commits the file.
The regular build workflow then normalizes it and redeploys, so the photo shows
up for everyone about a minute or two later. The uploader sees theirs right
away from the local file.

Deploy:

```sh
cd worker
npx wrangler login
npx wrangler secret put GH_TOKEN         # fine-grained PAT, Contents RW, this repo only
npx wrangler secret put UPLOAD_TOKEN     # must match CONFIG.uploadToken in app.js
npx wrangler deploy
```

If the deployed URL differs from the default, update `CONFIG.uploadUrl` in
`assets/app.js`. Setting it to an empty string hides the upload button.
