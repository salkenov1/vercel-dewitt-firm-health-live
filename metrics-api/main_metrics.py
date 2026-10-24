"""Read-only JSON feed of the gold tables for the firm-health dashboard.

A separate Cloud Run service from the two sync functions on purpose. This one
is reachable from a browser, so it holds no write code and no API keys: every
query below is a SELECT against gold, and the only secret it knows is the
bearer token that gates it.

    GET /?token=<DASH_TOKEN>      -> the whole payload, same shape as gen.js
    GET /?token=...&since=2026-01-01

Deploy with deploy_metrics_api.sh.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import functions_framework
from google.cloud import bigquery

PROJECT = os.environ.get("BQ_PROJECT", "unified-century-504515-d4")
LOCATION = os.environ.get("BQ_LOCATION", "US")
TOKEN = os.environ.get("DASH_TOKEN", "")
# Browsers send an Origin header; only these may read the response.
ORIGINS = [o.strip() for o in os.environ.get(
    "DASH_ORIGINS",
    "https://dewitt-firm-health-production.vercel.app",
).split(",") if o.strip()]
CACHE_SECONDS = int(os.environ.get("DASH_CACHE_SECONDS", "900"))
DEFAULT_SINCE = os.environ.get("DASH_SINCE", "2025-01-01")

_client: bigquery.Client | None = None
_cache: dict[str, tuple[float, dict]] = {}


def bq() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT, location=LOCATION)
    return _client


def rows(sql: str, **params) -> list[dict[str, Any]]:
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter(k, "STRING", v) for k, v in params.items()
    ]) if params else None
    out = []
    for r in bq().query(sql, job_config=cfg).result():
        d = {}
        for k, v in dict(r).items():
            # Dates go out as ISO strings; everything else stays numeric.
            d[k] = v.isoformat() if hasattr(v, "isoformat") else v
        out.append(d)
    return out


# --------------------------------------------------------------------------
# Queries. Identical to build_dashboard_data.py so the baked snapshot and the
# live feed can never disagree.
# --------------------------------------------------------------------------

Q_METRICS = """
SELECT * EXCEPT(pipeline_value), CAST(pipeline_value AS INT64) AS pipeline_value
FROM `gold.metrics_daily`
WHERE day >= PARSE_DATE('%Y-%m-%d', @since)
ORDER BY day
"""

Q_MONTHLY = """
SELECT FORMAT_DATE('%Y-%m', month) AS month,
       revenue_deposits AS revenue, expenses_total AS costs,
       personnel, marketing, admin AS ga,
       revenue_deposits - expenses_total AS operating_margin
FROM `gold.fct_finance_monthly`
WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR)
ORDER BY month
"""

Q_STAGE = """
SELECT casestatus AS stage, COUNT(*) AS cases,
       CAST(ROUND(AVG(age_days)) AS INT64) AS avg_days
FROM `gold.fct_case_stage_daily`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `gold.fct_case_stage_daily`)
GROUP BY stage ORDER BY cases DESC
"""

Q_LOAD_ATT = """
SELECT attorney, litigation, non_litigation
FROM `gold.fct_caseload_daily`
WHERE as_of_date = (SELECT MAX(as_of_date) FROM `gold.fct_caseload_daily`)
ORDER BY litigation + non_litigation DESC
"""

Q_LOAD_CM = """
SELECT COALESCE(NULLIF(case_manager,''),'Unassigned') AS case_manager,
       COUNTIF(is_litigation) AS litigation,
       COUNTIF(NOT is_litigation) AS non_litigation
FROM `gold.fct_case_stage_daily`
WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `gold.fct_case_stage_daily`)
GROUP BY case_manager ORDER BY litigation + non_litigation DESC
"""

Q_INTAKE = """
SELECT intake_worker AS worker,
       SUM(leads_handled) AS leads_handled,
       SUM(wanted)        AS wanted,
       SUM(wanted_signed) AS signed,
       ROUND(SAFE_DIVIDE(SUM(wanted_signed), NULLIF(SUM(wanted),0)), 3) AS wanted_signed_pct,
       CAST(NULL AS FLOAT64) AS wanted_signed_pct_prev
FROM `gold.fct_intake_monthly`
WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR)
-- HAVING resolves bare names to SELECT aliases first, so SUM(wanted) here
-- would mean SUM(SUM(wanted)). Reference the alias instead.
GROUP BY worker HAVING wanted > 0
ORDER BY wanted DESC
"""

Q_ATTORNEY = """
WITH cl AS (
  SELECT attorney, open_cases, litigation, non_litigation,
         CAST(ROUND(avg_age_days) AS INT64) AS avg_case_age_days, over_1y, over_2y
  FROM `gold.fct_caseload_daily`
  WHERE as_of_date = (SELECT MAX(as_of_date) FROM `gold.fct_caseload_daily`)
),
fy AS (
  SELECT attorney, ROUND(SUM(fees)) AS fees_ytd,
         ROUND(SAFE_DIVIDE(SUM(fees), NULLIF(SUM(cases_with_fee),0))) AS avg_fee_ytd,
         SUM(cases_with_fee) AS cases_settled
  FROM `gold.fct_fee_monthly`
  WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR) GROUP BY attorney
),
fm AS (
  SELECT attorney, ROUND(SUM(fees)) AS fees_mtd FROM `gold.fct_fee_monthly`
  WHERE month = DATE_TRUNC(CURRENT_DATE('America/New_York'), MONTH) GROUP BY attorney
),
dm AS (
  SELECT attorney, SUM(demands_sent) AS demands_sent FROM `gold.fct_demands_monthly`
  WHERE month >= DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR) GROUP BY attorney
)
SELECT cl.attorney, COALESCE(fm.fees_mtd,0) AS fees_mtd,
       COALESCE(fy.fees_ytd,0) AS fees_ytd, fy.avg_fee_ytd,
       cl.open_cases, cl.litigation, cl.non_litigation,
       cl.avg_case_age_days, cl.over_1y, cl.over_2y,
       COALESCE(dm.demands_sent,0) AS demands_sent,
       COALESCE(fy.cases_settled,0) AS cases_settled
FROM cl LEFT JOIN fy USING (attorney)
        LEFT JOIN fm USING (attorney)
        LEFT JOIN dm USING (attorney)
ORDER BY cl.open_cases DESC
"""

Q_KPI = """
WITH d AS (SELECT * FROM `gold.metrics_daily`),
k AS (SELECT CURRENT_DATE('America/New_York') AS td,
             DATE_TRUNC(CURRENT_DATE('America/New_York'), MONTH) AS mtd,
             DATE_TRUNC(CURRENT_DATE('America/New_York'), YEAR)  AS ytd),
pm AS (SELECT DATE_SUB(DATE_TRUNC(CURRENT_DATE('America/New_York'), MONTH), INTERVAL 1 MONTH) AS pm0,
              DATE_SUB(DATE_TRUNC(CURRENT_DATE('America/New_York'), MONTH), INTERVAL 1 DAY)  AS pm1),
latest AS (SELECT * FROM d ORDER BY day DESC LIMIT 1)
SELECT
  (SELECT ROUND(SUM(fees_collected)) FROM d, k  WHERE day >= k.mtd)                  AS fees_mtd,
  (SELECT ROUND(SUM(fees_collected)) FROM d, pm WHERE day BETWEEN pm.pm0 AND pm.pm1) AS fees_mtd_prev,
  (SELECT ROUND(SUM(fees_collected)) FROM d, k  WHERE day >= k.ytd)                  AS fees_ytd,
  (SELECT SUM(cases_signed) FROM d, k  WHERE day >= k.mtd)                           AS signed_month,
  (SELECT SUM(cases_signed) FROM d, pm WHERE day BETWEEN pm.pm0 AND pm.pm1)          AS signed_prior,
  (SELECT SUM(cases_signed) FROM d, k  WHERE day >= k.ytd)                           AS signed_ytd,
  (SELECT SUM(leads) FROM d, k WHERE day > DATE_SUB(k.td, INTERVAL 30 DAY))          AS leads_total,
  (SELECT SUM(leads) FROM d, k WHERE day > DATE_SUB(k.td, INTERVAL 60 DAY)
                                 AND day <= DATE_SUB(k.td, INTERVAL 30 DAY))         AS leads_total_prev,
  (SELECT SUM(wanted_leads) FROM d, k WHERE day > DATE_SUB(k.td, INTERVAL 30 DAY))   AS leads_wanted,
  (SELECT SUM(wanted_leads) FROM d, k WHERE day > DATE_SUB(k.td, INTERVAL 60 DAY)
                                        AND day <= DATE_SUB(k.td, INTERVAL 30 DAY))  AS leads_wanted_prev,
  (SELECT ROUND(SUM(ad_spend_google + ad_spend_meta)) FROM d, k
     WHERE day > DATE_SUB(k.td, INTERVAL 30 DAY))                                    AS spend_30,
  latest.avg_fee_12m, latest.sol_6m, latest.open_demands_30, latest.day AS as_of
FROM latest
"""

# Panels with no source in the warehouse yet. Empty, never invented: a
# fabricated number on a page someone may screenshot is worse than a blank.
EMPTY = [
    "fee_by_type", "marketing_sources", "cost_per_signed_daily",
    "case_list", "top25",
    "cp_cases", "cp_demands", "cp_offers", "ld_leads",
    "qb_deposits", "qb_purchases", "gads_campaign_stats", "meta_basic_ad",
]


def build_kpis(s: dict) -> list[dict]:
    wanted = s.get("leads_wanted") or 0
    spec = [
        ("fees_mtd", s.get("fees_mtd"), s.get("fees_mtd_prev"), "$", "this month", "Fees collected MTD"),
        ("fees_ytd", s.get("fees_ytd"), None, "$", "Jan 1 - today", "Fees collected YTD"),
        ("avg_fee_12m", s.get("avg_fee_12m"), None, "$", "rolling 12 months", "Average fee per settled case"),
        ("signed_month", s.get("signed_month"), s.get("signed_prior"), "n", "this month", "Cases signed this month"),
        ("signed_prior", s.get("signed_prior"), None, "n", "prior month", "Cases signed prior month"),
        ("signed_ytd", s.get("signed_ytd"), None, "n", "Jan 1 - today", "Cases signed YTD"),
        ("leads_total", s.get("leads_total"), s.get("leads_total_prev"), "n", "last 30 days", "Total leads"),
        ("leads_wanted", wanted, s.get("leads_wanted_prev"), "n", "last 30 days", "Wanted leads"),
        ("sol_6m", s.get("sol_6m"), None, "n", "today", "SOL within 6 months"),
        ("open_demands_30", s.get("open_demands_30"), None, "n", "today", "Open demands 30+ days"),
    ]
    if wanted:
        spec.append(("cost_per_wanted", round((s.get("spend_30") or 0) / wanted),
                     None, "$", "last 30 days", "Cost per wanted lead"))
    return [
        {"metric": m, "value": v, "prev": p, "unit": u, "window": w, "label": l}
        for m, v, p, u, w, l in spec if v is not None
    ]


def payload(since: str) -> dict:
    hit = _cache.get(since)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]

    kpi_src = rows(Q_KPI)
    s = kpi_src[0] if kpi_src else {}
    data: dict[str, Any] = {
        "metrics_daily": rows(Q_METRICS, since=since),
        "monthly": rows(Q_MONTHLY),
        "cases_by_stage": rows(Q_STAGE),
        "load_by_attorney": rows(Q_LOAD_ATT),
        "load_by_cm": rows(Q_LOAD_CM),
        "intake_workers": rows(Q_INTAKE),
        "attorney_perf": rows(Q_ATTORNEY),
        "kpis": build_kpis(s),
    }
    for name in EMPTY:
        data[name] = []
    data["_as_of"] = s.get("as_of")
    data["_generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    _cache[since] = (time.time(), data)
    return data


def cors(origin: str | None) -> dict[str, str]:
    h = {"Content-Type": "application/json", "Cache-Control": "no-store",
         "Vary": "Origin"}
    if origin and origin in ORIGINS:
        h["Access-Control-Allow-Origin"] = origin
        h["Access-Control-Allow-Headers"] = "Content-Type"
        h["Access-Control-Max-Age"] = "3600"
    return h


@functions_framework.http
def metrics_api(request):
    origin = request.headers.get("Origin")
    headers = cors(origin)

    if request.method == "OPTIONS":
        return ("", 204, headers)

    if not TOKEN:
        return (json.dumps({"error": "DASH_TOKEN is not set on the service"}),
                500, headers)

    supplied = (request.args.get("token")
                or request.headers.get("Authorization", "").removeprefix("Bearer ").strip())
    # Constant-time-ish: compare full strings, never report which part failed.
    if supplied != TOKEN:
        return (json.dumps({"error": "unauthorized"}), 401, headers)

    since = request.args.get("since") or DEFAULT_SINCE
    if len(since) != 10 or since[4] != "-" or since[7] != "-":
        return (json.dumps({"error": "since must be YYYY-MM-DD"}), 400, headers)

    try:
        body = payload(since)
    except Exception as exc:  # noqa: BLE001 - surface the class, not the detail
        return (json.dumps({"error": f"query failed: {type(exc).__name__}"}),
                500, headers)

    return (json.dumps(body, ensure_ascii=False, default=str), 200, headers)
