# MOB CRM

Private CRM for prospecting owners of physician-owned medical office buildings.
Properties are organized by state and tenant group, with owner contacts, call logging,
callbacks, search, filters, editing, CSV export, sale comps, and lease comps.

**Stack:** Node.js + Express (server-rendered HTML) + PostgreSQL.
Locally it can use embedded Postgres (PGlite under `data/pgdata`).
In production set `DATABASE_URL` to managed Postgres.

## Security note

This repository is intended to hold **application code only**.
Do not commit `data/`, workbooks, CSV exports, backups, screenshots, `.env`, sync tokens,
or any customer/contact records.

## Required environment variables

| Name | Purpose |
| --- | --- |
| `APP_PASSWORD` | Login password (required in production) |
| `SESSION_SECRET` | Session HMAC secret (required in production) |
| `DATABASE_URL` | Postgres connection URL (production / hosted) |
| `NODE_ENV` | Set to `production` on hosted deploys |
| `TZ_NAME` | Optional timezone (default host local) |
| `DATA_DIR` | Optional data root (default `data/` next to the app). Embedded Postgres uses `DATA_DIR/pgdata`. |
| `WORKBOOK_PATH` | Optional path to `Prospects_updated.xlsx` (default `DATA_DIR/Prospects_updated.xlsx`) |
| `DELTA_DIR` | Optional folder watched for `crm-delta-*.csv` imports (default `DATA_DIR/incoming`) |
| `REMOTE_SYNC_CONFIG` | Optional path to remote-sync JSON config on a box worker |
| `ALLOW_RESTORE` | Optional; must be `1` to allow restore API |

Local-only fallbacks exist for non-production (`APP_PASSWORD=changeme`, `SESSION_SECRET=dev-only-secret-change-me`). Production refuses to start when either value is missing or still set to those development placeholders.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Optional seed/import scripts expect local workbook/CSV inputs under `data/` (not included in this repo):

```bash
npm run extract          # workbook -> data/seed.json
npm run import           # seed.json -> database
npm run import:reset     # wipe + re-import
npm run seed:comps
npm run fetch:sales
npm run import:comps
```

## Deploy

`Dockerfile`, `railway.json`, and `render.yaml` are included.

Typical Railway flow:

1. Create a project and add Postgres
2. Deploy from this repo / Dockerfile
3. Set `NODE_ENV=production`, `APP_PASSWORD`, `SESSION_SECRET`, and `DATABASE_URL`
4. Attach a public domain and sign in

Do not put passwords or tokens in source files. Use the host's environment / secret store.

## Layout

- `src/` — Express app, routes, auth, comps, sync
- `public/` — static CSS
- `scripts/` — import/export/extract helpers (no customer datasets)
- `data/` — local only (gitignored): DB files, seeds, workbooks

## Area comps

Each property record has an **Area comps** block at the bottom of the page, after contacts, call history, linked comps, and property details. Previous and Next arrows by the address follow the filtered, sorted list the record was opened from, including across pages. A direct link walks the full list in newest-added order.

The green New marker is only for a property added in the last 7 days that has not been called. Any logged call outcome removes it. The marker is calculated when the page is read, so imports do not turn it back on and no status or callback field is rewritten for that purpose.

The Callbacks page keeps scheduled dates (set when a call is logged) in Due and Next 14 days. Two extra sections are calculated when the page is read and do not rewrite notes, statuses, or dates. **Haven't talked in 6 months** lists a real conversation older than 182 days. **Missed follow-ups** lists a past conversation whose notes mention selling or a later call, with no call logged after it. “Not selling” and similar negations stay off that list. A newly logged call drops the record from both sections.

Area comps list nearby closed sales (sold price, date, building SF, sale $/SF, cap) and leases (rent, tenant, term, lease type, source), with links to the comp and to the full city list. The default radius is 25 miles (`AREA_RADIUS_MILES`, up to 100; 50 is the wider setting). Property coordinates are labeled as miles. Records without coordinates use U.S. Census Bureau 2024 place and ZIP-tabulation centers and are labeled approximate. Same city is shown when a distance cannot be measured. A whole state is not treated as nearby.

Missing facts say **Unknown**. Asking prices are labeled asking and are not mixed into closed-sale medians.

Lease rows from the source `Crexi Inventory Export (medical office) 2026-11-06` keep their stored `rent_psf` value, but the screen labels it **NOI/SF** instead of actual rent. Later sources with an explicit rent still show as actual rent.

Buyers remain capped-sale only. The block is limited to medical and professional office comps.

```bash
npm test
```
