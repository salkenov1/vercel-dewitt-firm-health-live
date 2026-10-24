#!/usr/bin/env bash
# Create the read-only service account the dashboard reads BigQuery with.
#
# Run in Cloud Shell AFTER confirming you hold roles/resourcemanager.projectIamAdmin.
# Safe to re-run: every step is idempotent except the key, which is created once.
#
# Deliberately NOT project-wide BigQuery read access. The project holds
# casepeer_clients, which carries social security numbers, dates of birth and
# driver's licence numbers. A key scoped to the gold dataset exposes
# aggregates if it ever leaks; a project-wide one exposes the client file.
set -euo pipefail

PROJECT="${PROJECT:-unified-century-504515-d4}"
SA="${SA:-firm-health-dashboard}"
SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"
KEY="${KEY:-$HOME/fh-key.json}"
ME="$(gcloud config get-value account 2>/dev/null)"

echo "project : $PROJECT"
echo "account : $ME"
echo

# --- 0. confirm the grant is really there -----------------------------------
if ! gcloud projects get-iam-policy "$PROJECT" \
      --flatten="bindings[].members" --filter="bindings.members:${ME}" \
      --format="value(bindings.role)" | grep -qx "roles/resourcemanager.projectIamAdmin"; then
  echo "STOP: $ME does not hold roles/resourcemanager.projectIamAdmin on $PROJECT."
  echo "      Nothing below will work. Go back to the client before continuing."
  exit 1
fi
echo "ok: projectIamAdmin confirmed"

# --- 1. grant yourself the two IAM roles ------------------------------------
# projectIamAdmin can change the policy but cannot itself create accounts or
# keys - those are separate roles, which is why one grant was not enough.
for R in roles/iam.serviceAccountAdmin roles/iam.serviceAccountKeyAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="user:${ME}" --role="$R" --condition=None >/dev/null
  echo "granted $R to $ME"
done

# --- 2. the service account -------------------------------------------------
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  echo "service account already exists: $SA_EMAIL"
else
  gcloud iam service-accounts create "$SA" --project "$PROJECT" \
    --display-name="Firm health dashboard (read-only)" \
    --description="Reads the gold dataset for the Vercel dashboard. No write access." >/dev/null
  echo "created $SA_EMAIL"
fi

# --- 3. read access, scoped to gold -----------------------------------------
# jobUser is project-level because running a query is a project-level action,
# but it grants no access to data on its own.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/bigquery.jobUser --condition=None >/dev/null
echo "granted roles/bigquery.jobUser (project)"

bq add-iam-policy-binding --project_id="$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role=roles/bigquery.dataViewer "${PROJECT}:gold" >/dev/null
echo "granted roles/bigquery.dataViewer on dataset gold"

# The API falls back to silver only while gold.metrics_daily is still v1.
# Push metrics_daily.sqlx v2 and this grant can be removed.
if [ "${INCLUDE_SILVER:-1}" = "1" ]; then
  bq add-iam-policy-binding --project_id="$PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role=roles/bigquery.dataViewer "${PROJECT}:silver" >/dev/null
  echo "granted roles/bigquery.dataViewer on dataset silver (remove once metrics_daily v2 is pushed)"
fi

# --- 4. the key -------------------------------------------------------------
if [ -f "$KEY" ]; then
  echo "key already at $KEY - not creating another"
else
  gcloud iam service-accounts keys create "$KEY" --iam-account "$SA_EMAIL" --project "$PROJECT"
fi

echo
echo "=== paste this into Vercel as GCP_SA_KEY_B64 ==="
base64 -w0 "$KEY"; echo
echo
echo "Then delete the file:   rm $KEY"
echo "List keys later:        gcloud iam service-accounts keys list --iam-account $SA_EMAIL"
