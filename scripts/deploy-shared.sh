#!/usr/bin/env bash
#
# Deploy the shared xero-mcp Cloud Run service.
#
#   ./scripts/deploy-shared.sh
#
# Required env vars (with sensible defaults):
#   GCP_PROJECT      GCP project ID         (default: internal-mcps-496022)
#   GCP_REGION       Cloud Run region       (default: us-central1)
#   IMAGE            Container image ref    (default: <region>-docker.pkg.dev/<project>/xero-mcp/server:latest)
#   RUNNER_SA        Cloud Run service acct (default: xero-mcp-runner@<project>.iam.gserviceaccount.com)
#   SERVICE_NAME     Cloud Run service name (default: xero-mcp)
#
# Assumes one-time setup is done:
#   - Project exists, APIs enabled
#   - xero-mcp-runner SA exists
#   - Artifact Registry repo `xero-mcp` exists in $GCP_REGION
#   - Secret `xero-app-id` and `xero-app-secret` exist (web-app credentials)
#
# Creates if absent:
#   - Secret `mcp-jwt-secret` (HS256 signing key for our access tokens)
#   - IAM bindings on the three shared secrets for the runner SA
#   - Project-level secretAccessor + secretVersionAdder + secretmanager.admin
#     bindings the runner SA needs to create + read per-user
#     `xero-refresh-token-<sub>` secrets on the fly
set -euo pipefail

PROJECT="${GCP_PROJECT:-internal-mcps-496022}"
REGION="${GCP_REGION:-us-central1}"
SVC="${SERVICE_NAME:-xero-mcp}"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT}/xero-mcp/server:latest}"
RUNNER_SA="${RUNNER_SA:-xero-mcp-runner@${PROJECT}.iam.gserviceaccount.com}"

echo "Deploying ${SVC} to ${PROJECT}/${REGION}"
echo "Image:  ${IMAGE}"
echo

# 1. Ensure mcp-jwt-secret exists
if ! gcloud secrets describe mcp-jwt-secret --project="${PROJECT}" >/dev/null 2>&1; then
  echo "Creating mcp-jwt-secret..."
  openssl rand -hex 32 | gcloud secrets create mcp-jwt-secret \
    --project="${PROJECT}" \
    --data-file=-
else
  echo "mcp-jwt-secret already exists"
fi

# 2. Grant runner SA access to shared secrets
for s in xero-app-id xero-app-secret mcp-jwt-secret; do
  gcloud secrets add-iam-policy-binding "$s" \
    --project="${PROJECT}" \
    --member="serviceAccount:${RUNNER_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

# 3. Runner SA needs to create + read per-user xero-refresh-token-<sub> secrets.
#    Grant secretmanager.admin restricted by an IAM condition to ONLY those
#    secrets, so a compromise of the public service cannot reach mcp-jwt-secret,
#    xero-app-secret, or any other project secret.
#
#    The condition must reference the secret by its PROJECT NUMBER form
#    (projects/<number>/secrets/...), which is what Secret Manager evaluates in
#    resource.name — using the project ID silently matches nothing. We compute
#    the project number up-front and reuse it for PUBLIC_URL below.
#
#    No unconditional fallback: if this binding can't be created we want a loud
#    failure (set -e), never a silent grant of project-wide Secret Manager admin.
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')

gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${RUNNER_SA}" \
  --role="roles/secretmanager.admin" \
  --condition='expression=resource.name.startsWith("projects/'"${PROJECT_NUMBER}"'/secrets/xero-refresh-token-"),title=xero-refresh-token-only,description=Restrict admin to per-user refresh-token secrets' \
  >/dev/null

# 4. Compute the deterministic Cloud Run URL up-front so the container has a
#    valid PUBLIC_URL on first boot. Cloud Run gives every service a stable
#    URL of the form https://<service>-<project-number>.<region>.run.app
#    (in addition to the randomly-suffixed default URL).
PUBLIC_URL="https://${SVC}-${PROJECT_NUMBER}.${REGION}.run.app"
echo "computed PUBLIC_URL=${PUBLIC_URL}"

# 5. Deploy
#
#    max-instances=1 is REQUIRED, not a cost knob: the server keeps one
#    long-lived child process per user holding that user's Xero session, and Xero
#    issues single-use rotating refresh tokens. Two instances refreshing the same
#    user's token would invalidate each other -> invalid_grant -> a permanent auth
#    break. min-instances=1 keeps the instance warm; 2Gi gives headroom for the
#    resident per-user children. Horizontal scale needs a distributed per-user
#    refresh lock first (future work). Keep this in sync with the live service —
#    deploy.yaml only updates --image and will not re-apply these.
gcloud run deploy "${SVC}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --service-account="${RUNNER_SA}" \
  --port=8080 \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --concurrency=80 \
  --cpu=1 \
  --memory=2Gi \
  --timeout=3600 \
  --set-secrets="XERO_APP_CLIENT_ID=xero-app-id:latest,XERO_APP_CLIENT_SECRET=xero-app-secret:latest,MCP_JWT_SECRET=mcp-jwt-secret:latest" \
  --set-env-vars="GCP_PROJECT=${PROJECT},PUBLIC_URL=${PUBLIC_URL}"

URL="${PUBLIC_URL}"

cat <<EOF

Deployed: ${SVC}
Service URL: ${URL}

Next steps:
 1. In the Xero developer portal, add this redirect URI to your Web app:
        ${URL}/callback
 2. Send this URL to your team. They use it as the "Custom connector" URL in
    Claude Desktop -> Settings -> Connectors -> Add custom connector:
        ${URL}
    Claude pops a browser, they sign in at Xero, done.
 3. Health check (no auth needed):
        curl ${URL}/healthz
 4. OAuth discovery (no auth needed):
        curl ${URL}/.well-known/oauth-authorization-server

EOF
