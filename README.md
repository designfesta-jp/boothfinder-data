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

## Safeguards
- **Broken input:** if a header is missing, or the booth count drops below half of the previous run, the run fails. Nothing is published and the previous data stays live.
- **No change:** if the data hasn't changed since last time, the run doesn't publish.
- **Typo check:** booth numbers that aren't on the map are listed in each run's summary.

## Setup
- **Secret:** `SHEET_CSV_URL` holds the published CSV URL ("ウェブに公開", "公開用" tab only, CSV format). Settings → Secrets and variables → Actions.
- **Pages:** Settings → Pages → Source is set to "GitHub Actions".

## How to run it now
Actions tab → "出展者データを配信" → Run workflow. A manual run always publishes.

## Note
GitHub disables scheduled workflows in a public repo after 60 days with no activity. Before an event, check on the Actions tab that the workflow is enabled. If it shows "disabled", turn it back on with "Enable workflow".
