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

### gold only — and why there is no fallback

`gold.metrics_daily` is **v2**: all 22 columns, with `revenue`, `costs`,
`marketing` and `ga` populated for every day. The function reads it directly.

An earlier version fell back to the `silver` models when those columns were
missing. That fallback has been **removed**, and the `silver` grant with it,
because it could not work and should not have:

* all nine `silver` objects are **views over `firm_health`** (bronze). Querying
  a view needs permission on the tables beneath it, so `silver` access alone
  always fails — and granting bronze would hand a browser-facing credential
  access to the dataset holding client records.
* the service account this app uses holds `roles/bigquery.dataViewer` on
  **`gold` and nothing else**. That is verified behaviourally, not assumed:
  reads of `firm_health` and `silver`, and writes anywhere, are all denied.

The `INFORMATION_SCHEMA` probe is kept as a **guard, not a router**. If those
columns ever vanish, the request fails with a message naming the cause rather
than quietly serving blank money tiles.

### Panels left intentionally empty

`fee_by_type`, `marketing_sources`, `cost_per_signed_daily`, `case_list`,
`top25` and the raw-data tables return `[]`. They have no source in the
warehouse yet — marketing attribution reaches 238 of 1,465 leads, and medical
bills / policy limits need the CasePeer export. They render blank rather than
carrying invented numbers.

---

## How it reaches the warehouse

`GCP_SA_KEY_B64` — a JSON key for `firm-health-dashboard@…`, base64-encoded.
The function reads it server-side and queries BigQuery directly.

`api/metrics.mjs` still supports a second mode, `METRICS_URL` + `DASH_TOKEN`,
which proxies to the Cloud Run service in `metrics-api/`. That existed only
because we could not mint a key at the time, and it ran as the project's
default compute account — which could write as well as read. **Do not use it.**
The dedicated read-only account now exists, so the proxy mode is dead weight
and `metrics-api/` can be deleted once this is live.

## Environment variables

Set these on the Vercel project (Settings → Environment Variables), for
Production and Preview:

| Name | Required | Value |
| --- | --- | --- |
| `GCP_SA_KEY_B64` | **yes** | the `firm-health-dashboard` JSON key, base64-encoded |
| `GCP_PROJECT_ID` | no | defaults to `unified-century-504515-d4` |
| `BQ_LOCATION` | no | defaults to `US` |
| `DASH_SINCE` | no | first day served, defaults to `2025-01-01` |
| `DASH_CACHE_SECONDS` | no | in-function cache, defaults to `900` |

`GCP_SA_KEY_B64` is the only one you have to set. `DASH_AVG_FEE` no longer
exists — the pipeline-value multiplier lives in Dataform now
(`workflow_settings.yaml`, `vars.avg_fee`), so `pipeline_value` arrives from
gold already computed. `METRICS_URL` and `DASH_TOKEN` belong to the retired
proxy mode above; leave them unset.

The key is read only inside `api/metrics.mjs` and never reaches the browser.
The browser calls `/api/metrics` and gets rows back. `middleware.js` gates that
route too, so an unauthenticated visitor gets the password page, not data.

---

## The service account

`firm-health-dashboard@unified-century-504515-d4.iam.gserviceaccount.com`
**already exists** and is scoped. Do not re-create it, and in particular do
not add project-level roles or a `silver` grant — an earlier version of this
file told you to, and that was wrong. What it holds:

| Scope | Grant |
| --- | --- |
| project | `roles/bigquery.jobUser` — needed to run a query at all |
| `gold` | `roles/bigquery.dataViewer` |
| everything else | nothing |

Verified by acting as the account: it reads `gold`, and is denied on
`firm_health`, on `silver`, and on writes anywhere.

All that is left is a key:

```bash
PROJECT=unified-century-504515-d4
SA=firm-health-dashboard@unified-century-504515-d4.iam.gserviceaccount.com

gcloud iam service-accounts keys create /tmp/fh-key.json \
  --iam-account "$SA" --project "$PROJECT"

base64 -w0 /tmp/fh-key.json          # paste as GCP_SA_KEY_B64 in Vercel
shred -u /tmp/fh-key.json 2>/dev/null || rm -f /tmp/fh-key.json
```

This needs `roles/iam.serviceAccountKeyAdmin`, which is granted.

The key is a long-lived credential. It goes into the Vercel environment
variable and nowhere else — never into git, never into Slack, never into a
chat. If it leaks, revoke it:

```bash
gcloud iam service-accounts keys list --iam-account "$SA" --project "$PROJECT"
gcloud iam service-accounts keys delete KEY_ID --iam-account "$SA" --project "$PROJECT"
```

Never substitute the default compute account. Until step 4 of the IAM
migration it held `roles/editor`; even now it can build containers. This is a
read-only dashboard reachable from a browser and it gets a read-only identity.

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

Figures to sanity-check, read from `gold.metrics_daily` on **28 Oct 2026**:

* fees collected YTD — $4,391,028
* cases signed YTD — 376
* active cases — 694, pipeline value $13,533,000
* rolling 12-month average fee — $21,987
* statute risk within 6 months — 168

These move daily, so treat them as a shape check rather than exact targets: if
the dashboard shows fees in the low millions and active cases near 700, it is
reading the right tables. If it shows zeros or 2025 dates, it is not.
