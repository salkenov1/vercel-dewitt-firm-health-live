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
const AVG_FEE = Number(process.env.DASH_AVG_FEE || 19500);

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
// gold.metrics_daily is the spine. The version currently deployed is v1,
// which has revenue and costs as NULL and no marketing or ga column at all.
// Probe once; if those columns are missing, derive the daily series from the
// silver models instead so the Executive Scorecard still has its money tiles.
// Pushing metrics_daily.sqlx v2 makes the fast path apply automatically.
// --------------------------------------------------------------------------

const Q_PROBE = `
SELECT COUNTIF(column_name IN ('marketing','ga')) AS n
FROM \`gold.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name = 'metrics_daily'`;

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

const Q_DAILY_SILVER = `
WITH spine AS (SELECT d AS day FROM UNNEST(GENERATE_DATE_ARRAY(
                 PARSE_DATE('%Y-%m-%d', @since), CURRENT_DATE('America/New_York'))) AS d),
cs AS (SELECT * FROM \`silver.cp_cases\`),
fee AS (SELECT case_id, check_date, payment_amount FROM \`silver.cp_trusts\`
        WHERE is_attorney_fee AND NOT is_void
          AND check_date IS NOT NULL AND payment_amount IS NOT NULL),
ld AS (SELECT l.created_date, l.is_signed, l.signed_date_proxy,
              COALESCE(s.is_wanted, FALSE) AS is_wanted
       FROM \`silver.ld_leads\` l LEFT JOIN \`silver.ld_statuses\` s USING (status_id)),
f_leads AS (SELECT created_date AS day, COUNT(*) AS leads, COUNTIF(is_wanted) AS wanted_leads
            FROM ld WHERE created_date IS NOT NULL GROUP BY day),
f_signed AS (SELECT signed_date_proxy AS day, COUNT(*) AS cases_signed
             FROM ld WHERE is_signed AND signed_date_proxy IS NOT NULL GROUP BY day),
f_dem AS (SELECT sent_date AS day, COUNT(*) AS demands_sent
          FROM \`silver.cp_demands\` WHERE sent_date IS NOT NULL GROUP BY day),
f_fee AS (SELECT check_date AS day, ROUND(SUM(payment_amount),2) AS fees_collected,
                 COUNT(DISTINCT case_id) AS cases_settled FROM fee GROUP BY day),
f_sp AS (SELECT date_day AS day,
           ROUND(SUM(IF(platform='google_ads',spend,0)),2)   AS ad_spend_google,
           ROUND(SUM(IF(platform='facebook_ads',spend,0)),2) AS ad_spend_meta
         FROM \`silver.ad_spend_daily\` GROUP BY day),
f_gl AS (SELECT txn_date AS day,
           ROUND(SUM(IF(classification='Revenue' AND source='deposit', amount,0)),2) AS revenue,
           ROUND(SUM(IF(classification='Expense', amount,0)),2)                      AS costs,
           ROUND(SUM(IF(classification='Expense' AND category='Personnel Expenses', amount,0)),2) AS personnel,
           ROUND(SUM(IF(classification='Expense' AND category='Marketing Expenses', amount,0)),2) AS marketing,
           ROUND(SUM(IF(classification='Expense' AND category LIKE 'General%', amount,0)),2)      AS ga
         FROM \`silver.qb_gl_lines\`
         WHERE fully_qualified_name IS NOT NULL AND NOT is_trust GROUP BY day),
s_c AS (SELECT sp.day, COUNT(*) AS active_cases,
               COUNTIF(c.statute_date <= DATE_ADD(sp.day, INTERVAL 180 DAY)) AS sol_6m
        FROM spine sp JOIN cs c ON c.created_date <= sp.day
         AND (c.closed_date IS NULL OR c.closed_date > sp.day) GROUP BY sp.day),
s_d AS (SELECT sp.day, COUNT(*) AS open_demands_30 FROM spine sp
        JOIN \`silver.cp_demands\` d ON d.sent_date < DATE_SUB(sp.day, INTERVAL 30 DAY)
         AND NOT COALESCE(d.offer_accepted, FALSE)
        JOIN cs c ON c.case_id = d.case_id AND c.created_date <= sp.day
         AND (c.closed_date IS NULL OR c.closed_date > sp.day) GROUP BY sp.day),
s_f AS (SELECT sp.day, ROUND(SAFE_DIVIDE(SUM(f.payment_amount),
                 NULLIF(COUNT(DISTINCT f.case_id),0)),2) AS avg_fee_12m
        FROM spine sp JOIN fee f ON f.check_date > DATE_SUB(sp.day, INTERVAL 12 MONTH)
         AND f.check_date <= sp.day GROUP BY sp.day)
SELECT sp.day,
  COALESCE(f_gl.revenue,0) AS revenue, COALESCE(f_gl.costs,0) AS costs,
  COALESCE(f_gl.personnel,0) AS personnel, COALESCE(f_gl.marketing,0) AS marketing,
  COALESCE(f_gl.ga,0) AS ga,
  COALESCE(f_fee.fees_collected,0) AS fees_collected,
  COALESCE(f_signed.cases_signed,0) AS cases_signed,
  COALESCE(f_leads.leads,0) AS leads, COALESCE(f_leads.wanted_leads,0) AS wanted_leads,
  COALESCE(f_sp.ad_spend_google,0) AS ad_spend_google,
  COALESCE(f_sp.ad_spend_meta,0) AS ad_spend_meta,
  COALESCE(f_dem.demands_sent,0) AS demands_sent,
  COALESCE(f_fee.cases_settled,0) AS cases_settled,
  s_c.active_cases,
  CAST(ROUND(COALESCE(s_c.active_cases,0) * @avgFee) AS INT64) AS pipeline_value,
  s_f.avg_fee_12m, s_c.sol_6m, COALESCE(s_d.open_demands_30,0) AS open_demands_30,
  CAST(NULL AS FLOAT64) AS avg_file_days,
  CAST(NULL AS INT64) AS contact_overdue,
  CAST(NULL AS INT64) AS no_activity_30
FROM spine sp
LEFT JOIN f_leads USING (day) LEFT JOIN f_signed USING (day) LEFT JOIN f_dem USING (day)
LEFT JOIN f_fee USING (day) LEFT JOIN f_sp USING (day) LEFT JOIN f_gl USING (day)
LEFT JOIN s_c USING (day) LEFT JOIN s_d USING (day) LEFT JOIN s_f USING (day)
ORDER BY sp.day`;

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
const EMPTY = ['fee_by_type', 'marketing_sources', 'cost_per_signed_daily',
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
  if (schemaHasMarketing === null) {
    const [{ n }] = await q(Q_PROBE);
    schemaHasMarketing = Number(n) === 2;
  }
  const dailySql = schemaHasMarketing ? Q_DAILY_GOLD : Q_DAILY_SILVER;
  const dailyParams = schemaHasMarketing ? { since } : { since, avgFee: AVG_FEE };

  const [metrics_daily, monthly, cases_by_stage, load_by_attorney,
    load_by_cm, intake_workers, attorney_perf] = await Promise.all([
    q(dailySql, dailyParams), q(Q_MONTHLY), q(Q_STAGE), q(Q_LOAD_ATT),
    q(Q_LOAD_CM), q(Q_INTAKE), q(Q_ATTORNEY),
  ]);

  const data = {
    metrics_daily, monthly, cases_by_stage, load_by_attorney,
    load_by_cm, intake_workers, attorney_perf,
    kpis: kpisFrom(metrics_daily),
  };
  for (const k of EMPTY) data[k] = [];
  data._as_of = metrics_daily.length ? metrics_daily[metrics_daily.length - 1].day : null;
  data._source = schemaHasMarketing ? 'gold.metrics_daily' : 'silver (gold.metrics_daily is v1)';
  data._generated_at = new Date().toISOString();
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
