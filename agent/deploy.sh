#!/usr/bin/env bash
# Deploy the agent to Cloud Run with the ADK web UI. Run from Cloud Shell, from the agent/ folder:
#     bash deploy.sh
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-anchor-closure-agent}"

gcloud services enable run.googleapis.com aiplatform.googleapis.com bigquery.googleapis.com \
  cloudbuild.googleapis.com --project "$PROJECT"
# The Google-managed BigQuery MCP endpoint needs only the BigQuery API (enabled above).

# The Cloud Run runtime service account must be able to query BigQuery, call Gemini and use MCP.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for ROLE in roles/bigquery.user roles/bigquery.dataViewer roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" \
    --role="$ROLE" --condition=None --quiet >/dev/null || echo "  could not grant $ROLE (grant it in IAM)"
done

adk deploy cloud_run \
  --project "$PROJECT" \
  --region "$REGION" \
  --service_name "$SERVICE" \
  --with_ui \
  ./anchor_agent

# min-instances 1 avoids a cold start during the recorded demo.
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT" --min-instances 1 \
  --update-env-vars "GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=global"
