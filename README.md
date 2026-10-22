# DeWitt Firm Health — live

A standalone Vercel app that reproduces the existing dashboard exactly and
serves it from the BigQuery **gold** tables instead of generated sample data.

It is a separate project: deploying it does not touch
`dewitt-firm-health-production`, which keeps running untouched.

---

## What is in here

| File | Origin | Changed? |
| --- | --- | --- |
| `public/index.html` | the existing dashboard | **2 lines.** Byte-identical otherwise, CRLF preserved |
| `public/app.js` | the existing dashboard | **byte-identical** (sha1 `435baf4b…`) |
| `public/loader.js` | new | fetches `/api/metrics`, handles loading / empty / error, then starts `app.js` |
| `api/metrics.mjs` | new | server-side data access layer |
| `middleware.js` | the existing dashboard | **byte-identical** — same password gate |
| `vercel.json` | new | noindex header, 60 s function budget |
| `package.json` | new | one dependency: `@google-cloud/bigquery` |

The only two edits to `index.html`:

1. line 258 — the `Sample data` badge gains `id="fh-asof"` and reads
   `Connecting…` until data arrives, then `Live data · <date>`
2. line 422 — `<script src="gen.js">` and `<script src="app.js">` are replaced
   by `<script src="loader.js">`

`app.js` captures `window.SAMPLE_DATA` on its first line, so the data has to be
in place before it runs. `loader.js` fetches first, then injects `app.js`. That
is why the `app.js` tag moves rather than the file changing.

Every chart, filter, KPI card, table, tab and interaction is the original code
operating on the original data shape. Nothing was redesigned.

---

## Data sources

`api/metrics.mjs` builds the exact object the UI expects on
`window.SAMPLE_DATA`:

| Key | Gold table |
| --- | --- |
| `metrics_daily` | `gold.metrics_daily` — one row per day, the spine |
| `monthly` | `gold.fct_finance_monthly` |
| `cases_by_stage` | `gold.fct_case_stage_daily` (latest snapshot) |
| `load_by_attorney` | `gold.fct_caseload_daily` (latest `as_of_date`) |
| `load_by_cm` | `gold.fct_case_stage_daily` grouped by case manager |
| `intake_workers` | `gold.fct_intake_monthly` |
| `attorney_perf` | `fct_caseload_daily` + `fct_fee_monthly` + `fct_demands_monthly`, joined on `attorney` |
| `kpis` | derived in JS from `metrics_daily` — MTD, prior month, YTD, last 30 days |

### The v1 / v2 fallback

`gold.metrics_daily` currently deployed is **v1**: `revenue` and `costs` are
`NULL` and there is no `marketing` or `ga` column. The function probes
`INFORMATION_SCHEMA` once per cold start:

* columns present → reads `gold.metrics_daily` directly (fast path)
* columns absent → derives the same 22 columns from the `silver` models

So the money tiles on the Executive Scorecard work today, and pushing
`metrics_daily.sqlx` v2 switches it to the fast path with no code change. The
response carries `_source` so you can see which path ran.

### Panels left intentionally empty

`fee_by_type`, `marketing_sources`, `cost_per_signed_daily`, `case_list`,
`top25` and the raw-data tables return `[]`. They have no source in the
warehouse yet — marketing attribution reaches 238 of 1,465 leads, and medical
bills / policy limits need the CasePeer export. They render blank rather than
carrying invented numbers.

---

## Environment variables

Set these on the Vercel project (Settings → Environment Variables), for
Production and Preview:

| Name | Required | Value |
| --- | --- | --- |
| `GCP_SA_KEY_B64` | **yes** | the service-account JSON key, base64-encoded |
| `GCP_PROJECT_ID` | no | defaults to `unified-century-504515-d4` |
| `BQ_LOCATION` | no | defaults to `US` |
| `DASH_SINCE` | no | first day served, defaults to `2025-01-01` |
| `DASH_CACHE_SECONDS` | no | in-function cache, defaults to `900` |
| `DASH_AVG_FEE` | no | pipeline-value multiplier, defaults to `19500` |

The key is read only inside `api/metrics.mjs` and never reaches the browser.
The browser calls `/api/metrics` and gets rows back. `middleware.js` gates that
route too, so an unauthenticated visitor gets the password page, not data.

---

## What is still needed — and it is exactly one thing

**A BigQuery service account and a JSON key for it.**

```bash
PROJECT=unified-century-504515-d4
SA=firm-health-dashboard

gcloud iam service-accounts create "$SA" \
  --display-name="Firm health dashboard (read-only)" --project "$PROJECT"

for ROLE in roles/bigquery.dataViewer roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA}@${PROJECT}.iam.gserviceaccount.com" \
    --role "$ROLE"
done

gcloud iam service-accounts keys create /tmp/fh-key.json \
  --iam-account "${SA}@${PROJECT}.iam.gserviceaccount.com" --project "$PROJECT"

base64 -w0 /tmp/fh-key.json          # paste this as GCP_SA_KEY_B64
rm /tmp/fh-key.json
```

`roles/bigquery.dataViewer` at project level covers both `gold` and `silver`;
`silver` is required for the v1 fallback path above. Scope it to the two
datasets instead if you prefer.

This needs `roles/iam.serviceAccountAdmin`, which is the role already on the
open-items list. **Until it is granted this app cannot read BigQuery** — it
will deploy, show its error panel, and say the warehouse could not be reached.
There is no way around that from the application side: a credential has to
exist for the function to use. Do not substitute the default compute account —
it can write to everything in the project, and this is a read-only dashboard
reachable from a browser.

---

## Deploy

```bash
npm install
vercel link          # first time: create a NEW project, do not pick the existing one
vercel --prod
```

Vercel serves `public/` as static files and `api/metrics.mjs` as a Node
function; no build step is required.

After the first deploy, set the environment variables above and redeploy so the
function picks them up.

### Before sharing the URL

The existing project has SSO protection set to `all_except_custom_domains`. If
this new project inherits that, anyone not on the `dnl18` Vercel team gets a
401 before the password gate renders. Either add them to the team, attach a
custom domain, or turn SSO off and rely on `middleware.js`.

---

## Verifying it works

```bash
curl -s "https://<deployment>/api/metrics" | head -c 400
```

A healthy response starts with `{"metrics_daily":[{"day":"2025-01-01",…`.
Failures are JSON with an `error` key:

| Error | Meaning |
| --- | --- |
| `GCP_SA_KEY_B64 is not set` | the variable is missing on this environment |
| `…is not valid base64-encoded JSON` | the key was pasted un-encoded, or truncated |
| `The service account cannot read the gold dataset.` | key is valid, roles are missing |
| `A table the dashboard needs is missing from the warehouse.` | a gold table was dropped or renamed |

Figures to sanity-check against the briefing, as of 22 Oct 2026:

* fees collected YTD — $4,372,695
* cases signed YTD — 372
* active cases — 696, pipeline value $13,572,000
* rolling 12-month average fee — $21,987
* statute risk within 6 months — 168
