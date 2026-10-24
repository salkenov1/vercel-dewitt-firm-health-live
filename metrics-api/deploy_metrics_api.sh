#!/usr/bin/env bash
# Deploy the read-only metrics feed.  Source file: main_metrics.py
#
# A third Cloud Run service, separate from the two sync functions. This is the
# only one a browser can reach, so it is also the only one with no write code
# and no third-party API keys in its environment.
#
# Before the first deploy, mint the shared token and store it:
#
#   TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
#   printf '%s' "$TOKEN" | gcloud secrets create DASH_TOKEN --data-file=- \
#     --project unified-century-504515-d4
#   echo "put this in Vercel as DASH_TOKEN: $TOKEN"
set -euo pipefail

PROJECT="${PROJECT:-unified-century-504515-d4}"
REGION="${REGION:-us-east5}"
SERVICE="${SERVICE:-firm-health-metrics-api}"
# TODO: swap for a dedicated read-only SA once roles/iam.serviceAccountAdmin
# is granted. Until then this inherits the default compute account, which can
# write as well as read - the reason the swap is still on the open-items list.
SA_EMAIL="${SA_EMAIL:-70322860196-compute@developer.gserviceaccount.com}"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --function metrics_api \
  --set-build-env-vars "GOOGLE_FUNCTION_SOURCE=main_metrics.py" \
  --timeout 120 \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 3 \
  --concurrency 20 \
  --allow-unauthenticated \
  --service-account "$SA_EMAIL" \
  --set-env-vars "BQ_PROJECT=${PROJECT},BQ_LOCATION=US,DASH_CACHE_SECONDS=900,DASH_SINCE=2025-01-01" \
  --set-secrets "DASH_TOKEN=DASH_TOKEN:latest" \
  --project "$PROJECT"

echo
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" \
        --format='value(status.url)' --project "$PROJECT")
echo "Service URL: $URL"
echo
echo "Set these two in Vercel (Project Settings -> Environment Variables):"
echo "  METRICS_URL = $URL"
echo "  DASH_TOKEN  = <the token you stored in Secret Manager>"
