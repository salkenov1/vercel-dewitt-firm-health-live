// Server-side data access layer for the firm-health dashboard.
//
// Runs on Vercel as a Node serverless function. The service-account key lives
// only in the GCP_SA_KEY_B64 environment variable and never leaves this file:
// the browser calls /api/metrics and receives rows, never credentials.
//
// Returns the same object shape the UI already expects on window.SAMPLE_DATA,
// so public/app.js needs no changes at all.

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT = process.env.GCP_PROJECT_ID || 'unified-century-504515-d4';
const LOCATION = process.env.BQ_LOCATION || 'US';
const SINCE_DEFAULT = process.env.DASH_SINCE || '2025-01-01';
const CACHE_MS = Number(process.env.DASH_CACHE_SECONDS || 900) * 1000;
// DASH_AVG_FEE is gone: the pipeline-value multiplier now lives in Dataform
// (workflow_settings.yaml vars.avg_fee), so gold.metrics_daily.pipeline_value
// arrives already computed. Setting it here would have had no effect.

let client = null;
let schemaHasMarketing = null;          // probed once per cold start
const cache = new Map();                // since -> { at, body }

function bq() {
  if (client) return client;
  const b64 = process.env.GCP_SA_KEY_B64;
  if (!b64) throw new Error('GCP_SA_KEY_B64 is not set');
  let creds;
  try {
    creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new Error('GCP_SA_KEY_B64 is not valid base64-encoded JSON');
  }
  client = new BigQuery({
    projectId: PROJECT,
    credentials: { client_email: creds.client_email, private_key: creds.private_key },
  });
  return client;
}

// For panels whose gold table may not exist yet. A newly modelled metric is
// deployed in two places - Dataform and here - and whichever lands first must
// not take the dashboard down. On any failure the panel stays blank, exactly
// as it was before the metric existed, and the reason is reported in _degraded
// so a permanently empty panel is visible rather than silent.
const degraded = [];
async function qSafe(name, sql, params) {
  try {
    return await q(sql, params);
  } catch (err) {
    degraded.push({ panel: name, reason: String(err.message || err).slice(0, 200) });
    return [];
  }
}

async function q(sql, params) {
  const [rows] = await bq().query({ query: sql, location: LOCATION, params });
  // BigQuery hands dates back as objects; the UI wants ISO day strings.
  return rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = v && typeof v === 'object' && typeof v.value === 'string' ? v.value : v;
    }
    return o;
  });
}

// --------------------------------------------------------------------------
// gold.metrics_daily is the spine, and the only table this dashboard reads a
// daily series from. v2 is deployed: all 22 columns, with revenue, costs,
// marketing and ga populated.
//
// The probe stays as a guard, not a router. If those columns ever disappear
// the request fails with a message naming the cause, rather than silently
// serving blank money tiles. There is deliberately no silver fallback: the
// dashboard service account holds READ on `gold` alone, and silver's models
// are VIEWS over firm_health, so reading them would mean giving bronze access
// to a credential that lives in a browser-facing function.
// --------------------------------------------------------------------------

const Q_PROBE = `
SELECT COUNTIF(column_name IN ('marketing','ga')) AS n
FROM \`gold.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name = 'metrics_daily'`;

// Metric 27. avg_fee is the all-time average; the model also carries
// avg_fee_12m for a rolling window, and cases_with_fee so a one-case "average"
// can be recognised as one. See definitions/gold/fct_fee_by_type.sqlx.
const Q_FEE_BY_TYPE = `
SELECT case_type, avg_fee, cases_with_fee, fees_total, avg_fee_12m, cases_with_fee_12m
FROM \`gold.fct_fee_by_type\`
ORDER BY fees_total DESC`;

const Q_DAILY_GOLD = `
SELECT day, revenue, costs, personnel, marketing, ga, fees_collected,
       cases_signed, leads, wanted_leads, ad_spend_google, ad_spend_meta,
       demands_sent, cases_settled, active_cases,
       CAST(pipeline_value AS INT64) AS pipeline_value,
       avg_fee_12m, sol_6m, open_demands_30,
       avg_file_days, contact_overdue, no_activity_30
FROM \`gold.metrics_daily\`
WHERE day >= PARSE_DATE('%Y-%m-%d', @since)
ORDER BY day`;

const Q_MONTHLY = `
SELECT FORMAT_DATE('%Y-%m', month) AS month,
       revenue_deposits AS revenue, expenses_total AS costs,
       personnel, marketing, admin AS ga,
       revenue_deposits - expenses_total AS operating_margin
FROM \`gold.fct_finance_monthly\`
WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR)
ORDER BY month`;

const Q_STAGE = `
SELECT casestatus AS stage, COUNT(*) AS cases,
       CAST(ROUND(AVG(age_days)) AS INT64) AS avg_days
FROM \`gold.fct_case_stage_daily\`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM \`gold.fct_case_stage_daily\`)
GROUP BY stage ORDER BY cases DESC`;

const Q_LOAD_ATT = `
SELECT attorney, litigation, non_litigation
FROM \`gold.fct_caseload_daily\`
WHERE as_of_date = (SELECT MAX(as_of_date) FROM \`gold.fct_caseload_daily\`)
ORDER BY litigation + non_litigation DESC`;

const Q_LOAD_CM = `
SELECT COALESCE(NULLIF(case_manager,''),'Unassigned') AS case_manager,
       COUNTIF(is_litigation) AS litigation, COUNTIF(NOT is_litigation) AS non_litigation
FROM \`gold.fct_case_stage_daily\`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM \`gold.fct_case_stage_daily\`)
GROUP BY case_manager ORDER BY litigation + non_litigation DESC`;

const Q_INTAKE = `
SELECT intake_worker AS worker, SUM(leads_handled) AS leads_handled,
       SUM(wanted) AS wanted, SUM(wanted_signed) AS signed,
       ROUND(SAFE_DIVIDE(SUM(wanted_signed), NULLIF(SUM(wanted),0)), 3) AS wanted_signed_pct,
       CAST(NULL AS FLOAT64) AS wanted_signed_pct_prev
FROM \`gold.fct_intake_monthly\`
WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR)
GROUP BY worker HAVING wanted > 0
ORDER BY wanted DESC`;

const Q_ATTORNEY = `
WITH cl AS (SELECT attorney, open_cases, litigation, non_litigation,
              CAST(ROUND(avg_age_days) AS INT64) AS avg_case_age_days, over_1y, over_2y
            FROM \`gold.fct_caseload_daily\`
            WHERE as_of_date = (SELECT MAX(as_of_date) FROM \`gold.fct_caseload_daily\`)),
fy AS (SELECT attorney, ROUND(SUM(fees)) AS fees_ytd,
         ROUND(SAFE_DIVIDE(SUM(fees), NULLIF(SUM(cases_with_fee),0))) AS avg_fee_ytd,
         SUM(cases_with_fee) AS cases_settled
       FROM \`gold.fct_fee_monthly\`
       WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR) GROUP BY attorney),
fm AS (SELECT attorney, ROUND(SUM(fees)) AS fees_mtd FROM \`gold.fct_fee_monthly\`
       WHERE month = DATE_TRUNC(CURRENT_DATE('America/New_York'), MONTH) GROUP BY attorney),
dm AS (SELECT attorney, SUM(demands_sent) AS demands_sent FROM \`gold.fct_demands_monthly\`
       WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR) GROUP BY attorney)
SELECT cl.attorney, COALESCE(fm.fees_mtd,0) AS fees_mtd,
       COALESCE(fy.fees_ytd,0) AS fees_ytd, fy.avg_fee_ytd,
       cl.open_cases, cl.litigation, cl.non_litigation,
       cl.avg_case_age_days, cl.over_1y, cl.over_2y,
       COALESCE(dm.demands_sent,0) AS demands_sent,
       COALESCE(fy.cases_settled,0) AS cases_settled
FROM cl LEFT JOIN fy USING (attorney) LEFT JOIN fm USING (attorney) LEFT JOIN dm USING (attorney)
ORDER BY cl.open_cases DESC`;

// Panels with no source in the warehouse yet. Empty, never invented.
const EMPTY = ['marketing_sources', 'cost_per_signed_daily',
  'case_list', 'top25', 'cp_cases', 'cp_demands', 'cp_offers', 'ld_leads',
  'qb_deposits', 'qb_purchases', 'gads_campaign_stats', 'meta_basic_ad'];

function kpisFrom(daily) {
  if (!daily.length) return [];
  const last = daily[daily.length - 1];
  const today = last.day;
  const ym = today.slice(0, 7);
  const year = today.slice(0, 4);
  const prevMonth = (() => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const windowDays = (n, end) => {
    const e = daily.findIndex((r) => r.day === end);
    const hi = e < 0 ? daily.length : e + 1;
    return daily.slice(Math.max(0, hi - n), hi);
  };
  const back30 = (() => {
    const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  const mtd = daily.filter((r) => r.day.slice(0, 7) === ym);
  const pm = daily.filter((r) => r.day.slice(0, 7) === prevMonth);
  const ytd = daily.filter((r) => r.day.slice(0, 4) === year);
  const l30 = windowDays(30, today);
  const p30 = windowDays(30, back30);

  const wanted30 = sum(l30, 'wanted_leads');
  const spend30 = sum(l30, 'ad_spend_google') + sum(l30, 'ad_spend_meta');

  const out = [
    ['fees_mtd', Math.round(sum(mtd, 'fees_collected')), Math.round(sum(pm, 'fees_collected')), '$', 'this month', 'Fees collected MTD'],
    ['fees_ytd', Math.round(sum(ytd, 'fees_collected')), null, '$', 'Jan 1 - today', 'Fees collected YTD'],
    ['avg_fee_12m', last.avg_fee_12m, null, '$', 'rolling 12 months', 'Average fee per settled case'],
    ['signed_month', sum(mtd, 'cases_signed'), sum(pm, 'cases_signed'), 'n', 'this month', 'Cases signed this month'],
    ['signed_prior', sum(pm, 'cases_signed'), null, 'n', 'prior month', 'Cases signed prior month'],
    ['signed_ytd', sum(ytd, 'cases_signed'), null, 'n', 'Jan 1 - today', 'Cases signed YTD'],
    ['leads_total', sum(l30, 'leads'), sum(p30, 'leads'), 'n', 'last 30 days', 'Total leads'],
    ['leads_wanted', wanted30, sum(p30, 'wanted_leads'), 'n', 'last 30 days', 'Wanted leads'],
    ['sol_6m', last.sol_6m, null, 'n', 'today', 'SOL within 6 months'],
    ['open_demands_30', last.open_demands_30, null, 'n', 'today', 'Open demands 30+ days'],
    ['demands_month', sum(mtd, 'demands_sent'), sum(pm, 'demands_sent'), 'n', 'this month', 'Demands sent this month'],
  ];
  if (wanted30) out.push(['cost_per_wanted', Math.round(spend30 / wanted30), null, '$', 'last 30 days', 'Cost per wanted lead']);
  return out
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([metric, value, prev, unit, window, label]) => ({ metric, value, prev, unit, window, label }));
}

async function build(since) {
  degraded.length = 0;   // per build, not per process: a stale entry from an
                         // earlier request would report a panel as broken
                         // after it had started working again
  if (schemaHasMarketing === null) {
    const [{ n }] = await q(Q_PROBE);
    schemaHasMarketing = Number(n) === 2;
  }
  if (!schemaHasMarketing) {
    const e = new Error(
      'gold.metrics_daily is missing the marketing/ga columns (v1 schema). ' +
      'Push metrics_daily.sqlx v2 and re-run the Dataform workflow. ' +
      'This dashboard reads gold only, by design, so there is no fallback.');
    e.expose = true;
    throw e;
  }
  const dailySql = Q_DAILY_GOLD;
  const dailyParams = { since };

  const [metrics_daily, monthly, cases_by_stage, load_by_attorney,
    load_by_cm, intake_workers, attorney_perf, fee_by_type] = await Promise.all([
    q(dailySql, dailyParams), q(Q_MONTHLY), q(Q_STAGE), q(Q_LOAD_ATT),
    q(Q_LOAD_CM), q(Q_INTAKE), q(Q_ATTORNEY),
    qSafe('fee_by_type', Q_FEE_BY_TYPE),
  ]);

  const data = {
    metrics_daily, monthly, cases_by_stage, load_by_attorney,
    load_by_cm, intake_workers, attorney_perf, fee_by_type,
    kpis: kpisFrom(metrics_daily),
  };
  for (const k of EMPTY) data[k] = [];
  data._as_of = metrics_daily.length ? metrics_daily[metrics_daily.length - 1].day : null;
  data._source = 'gold.metrics_daily';
  data._generated_at = new Date().toISOString();
  if (degraded.length) data._degraded = degraded.splice(0);
  return data;
}

// Two ways to reach the warehouse, chosen by which variables are set.
//
//   GCP_SA_KEY_B64            -> query BigQuery straight from here (preferred)
//   METRICS_URL + DASH_TOKEN  -> proxy to the Cloud Run metrics service
//
// The second exists because creating a service-account key needs IAM roles we
// do not hold yet, while deploying a Cloud Run service needs only roles we
// already have. When the key arrives, set GCP_SA_KEY_B64 and remove the other
// two: this file takes the direct path again with no code change.
function mode() {
  if (process.env.GCP_SA_KEY_B64) return 'bigquery';
  if (process.env.METRICS_URL && process.env.DASH_TOKEN) return 'cloudrun';
  return 'unconfigured';
}

async function fromCloudRun(since) {
  const url = new URL(process.env.METRICS_URL);
  url.searchParams.set('since', since);
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.DASH_TOKEN}` },
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('the metrics service did not return JSON');
  }
  if (!r.ok || body.error) throw new Error(body.error || `metrics service HTTP ${r.status}`);
  return body;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const how = mode();
  if (how === 'unconfigured') {
    return res.status(500).end(JSON.stringify({
      error: 'Not configured. Set GCP_SA_KEY_B64, or METRICS_URL together with DASH_TOKEN.',
    }));
  }

  const since = typeof req.query?.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)
    ? req.query.since : SINCE_DEFAULT;

  const hit = cache.get(since);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.setHeader('X-Cache', 'hit');
    return res.status(200).end(JSON.stringify(hit.body));
  }

  try {
    const body = how === 'cloudrun' ? await fromCloudRun(since) : await build(since);
    if (!body.metrics_daily?.length) {
      return res.status(200).end(JSON.stringify({
        ...body,
        _empty: true,
        _message: `No rows in the warehouse from ${since} onward.`,
      }));
    }
    cache.set(since, { at: Date.now(), body });
    res.setHeader('X-Cache', 'miss');
    return res.status(200).end(JSON.stringify(body));
  } catch (err) {
    // Surface enough to debug, never the key or the full stack.
    const msg = String(err?.message || err);
    const safe = msg.includes('metrics service') ? msg
      : err?.name === 'TimeoutError' ? 'the metrics service took too long to answer'
      : msg.includes('GCP_SA_KEY_B64') ? msg
      : msg.includes('Permission') || msg.includes('403')
        ? 'The service account cannot read the gold dataset.'
        : msg.includes('Not found') || msg.includes('404')
          ? 'A table the dashboard needs is missing from the warehouse.'
          : 'The warehouse query failed.';
    console.error('metrics query failed:', msg);
    return res.status(502).end(JSON.stringify({ error: safe }));
  }
}
