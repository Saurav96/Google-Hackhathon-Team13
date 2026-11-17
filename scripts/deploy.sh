#!/usr/bin/env bash
# Deploys the agent and the relief desk screen to Cloud Run. Run from anywhere: bash scripts/deploy.sh
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-qwiklabs-gcp-04-76b40991ee4b}"
REGION="us-central1"
SERVICE="grant-advisor"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The Maps key lives only in the local .env and on the service, never in the repo.
MAPS_API_KEY="${MAPS_API_KEY:-$(grep -s '^MAPS_API_KEY=' "$ROOT/agent/microgrants/.env" | cut -d= -f2 || true)}"

if command -v npm >/dev/null 2>&1; then
  (cd "$ROOT/agent/ui" && npm install --no-audit --no-fund --loglevel=error && npm run build)
else
  echo "npm not found: deploying the screen already built in agent/web."
fi

# Gemini is served from the global location, not from the Cloud Run region.
gcloud run deploy "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --source="$ROOT/agent" \
  --allow-unauthenticated \
  --min-instances=1 --max-instances=2 --session-affinity \
  --memory=1Gi --cpu=1 --no-cpu-throttling --timeout=300 \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=global,BQ_DATASET=a4i_econ,BQ_GRAPH=LocalEconomy,AGENT_MODEL=gemini-3.8-flash,MAPS_API_KEY=$MAPS_API_KEY" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
echo "Live: $URL"
curl -fsS -o /dev/null "$URL/api/overview" && echo "Health check passed."
