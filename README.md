# boothfinder-data

This repo delivers exhibitor data for boothfinder, the booth-search map for Design Festa. It takes exhibitor data from a spreadsheet and publishes it on GitHub Pages.

boothfinder itself lives in a private repo (`designfesta-jp/boothfinder`). This public repo holds only the fetch and conversion script and the workflow. The data is never committed; each run uploads it straight to Pages.

## How it works
1. Every 15 minutes, GitHub Actions fetches the exhibitor spreadsheet's "公開用" tab, which is published to the web as CSV.
2. It converts the CSV into the shape boothfinder uses (the same shape as `boothDataMap` in `map-data.txt`).
3. It publishes the result to `https://designfesta-jp.github.io/boothfinder-data/exhibitors.json`.

The conversion follows the same rules as the map editor (`tools/map-editor-V5v5.html` in boothfinder):
- columns are matched by their header names;
- only http(s) URLs are kept;
- booth numbers are zero-padded to 3 digits.

## Photos
Exhibitor photos are the original uploads in DFGApp's storage. They average 2.4MB each, which is too heavy for the booth detail's 132px squares. Each run therefore also publishes small versions:
- `t/<hash>.jpg` is a 264px square JPEG of every photo, listed in each exhibitor's `th` array in the same order as `img`. An empty string means it couldn't be made this time, so boothfinder falls back to the original.
- HEIC photos are converted to JPEG. Their `img` entry points to a 960px version at `l/<hash>.jpg`, because most browsers can't show HEIC.
- Files browsers can't show (PDF, PSD, RAW, video) and photos that return 4xx are dropped from `img`.
- `photos.json` records each photo's result (`ok`, `heic` or `bad`), so `bad` files aren't downloaded again.
- Made photos are reused from the Actions cache (`.photo-cache`) first, then from the previous Pages deploy. Only new photos are fetched and converted. The first run fetches all ~10,000 originals (~24GB), which takes a while; later runs are quick.
- If the sheet hasn't changed and no photo is waiting for a retry, a scheduled run stops early without touching photos.

## Safeguards
- **Broken input:** if a header is missing, or the booth count drops below half of the previous run, the run fails. Nothing is published and the previous data stays live.
- **No change:** if the data hasn't changed since last time, the run doesn't publish.
- **Typo check:** booth numbers that aren't on the map are listed in each run's summary.

## Setup
- **Secret:** `SHEET_CSV_URL` holds the published CSV URL ("ウェブに公開", "公開用" tab only, CSV format). Settings → Secrets and variables → Actions.
- **Pages:** Settings → Pages → Source is set to "GitHub Actions".

## How to run it now
Actions tab → "出展者データを配信" → Run workflow. A manual run always publishes.

Locally: `npm ci`, then `SHEET_CSV_FILE=<csv> node scripts/convert.mjs site`. Photos are cached in `.photo-cache`.

## Note
GitHub disables scheduled workflows in a public repo after 60 days with no activity. Before an event, check on the Actions tab that the workflow is enabled. If it shows "disabled", turn it back on with "Enable workflow".
