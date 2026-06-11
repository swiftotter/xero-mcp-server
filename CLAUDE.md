# CLAUDE.md

Xero MCP server (TypeScript). Build locally with `npm run build` (`src/` → `dist/`); lint with `npm run lint`.

## Deployment

Production is the shared Cloud Run service **`xero-mcp`** (GCP project `internal-mcps-496022`, region `us-central1`), at `https://xero-mcp-1074937591843.us-central1.run.app`.

**How it deploys:** merging a PR into **`swiftotter/main`** triggers `.github/workflows/deploy.yaml`. It builds the Docker image **on the runner**, `docker push`es it to Artifact Registry (`us-central1-docker.pkg.dev/internal-mcps-496022/xero-mcp/server`), rolls out Cloud Run, then verifies the new revision (image matches, 100% traffic, `/status` healthy) — so a **green Deploy run** means it actually shipped. The image builds from `src/` (Docker runs `npm run build`), so **`dist/` is not committed**.

> Build on the runner — **not** `gcloud builds submit`. Cloud Build's source-staging upload fails in CI ("forbidden … serviceusage.services.use") regardless of SA roles; the runner build only needs `artifactregistry.writer`, which the deploy SA has.

**Process:**
1. Branch from `swiftotter/main`; push to the **`swiftotter`** remote — not `origin` (read-only XeroAPI upstream).
2. Open a PR against `swiftotter/main`. Direct push to `main` is blocked.
3. The merge is the deploy. A human merges (not automation).

**Rollback:** re-run Deploy via `workflow_dispatch` with an existing `image_tag` — it skips the build and rolls out that image.

**Ops (run as a project Owner):**
```bash
# what's live right now:
gcloud run services describe xero-mcp --project=internal-mcps-496022 --region=us-central1 \
  --format="value(status.latestReadyRevisionName, spec.template.spec.containers[0].image)"

# manual build + deploy (same build-on-runner approach as CI; do NOT use gcloud builds submit):
IMG=us-central1-docker.pkg.dev/internal-mcps-496022/xero-mcp/server:$(git rev-parse --short=12 HEAD)
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
docker build --platform=linux/amd64 -t "$IMG" .
docker push "$IMG"
gcloud run services update xero-mcp --project=internal-mcps-496022 --region=us-central1 --image="$IMG" --quiet
```
