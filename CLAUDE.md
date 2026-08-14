# CLAUDE.md

Xero MCP server (TypeScript). Build locally with `npm run build` (`src/` → `dist/`); lint with `npm run lint`. There is no test framework — verification is a set of `npm run verify:*` scripts under `scripts/` (`fs-guard`, `stateless`, `schemas`, `confirmation-gate`, `auth-recovery`). Add to one of those when you add an invariant.

## Tool schema invariants (don't regress)

- **Array/object arguments accept a JSON-*string* encoding; scalars do not.** Real clients stringify complex arguments even against a correct schema — Cowork sends `create-manual-journal`'s `manualJournalLines` as `"[{…},{…}]"`, which a bare `z.array()` rejects with `-32602 Expected array, received string`. `coerceJsonishShape()` (`src/helpers/coerce-jsonish-args.ts`), applied once in `register()` in `src/tools/tool-factory.ts`, wraps every array/object node in a `z.preprocess` that `JSON.parse`s a string that looks like JSON, at every nesting depth. Scalars stay strict on purpose: `confirm: "true"` must keep failing, or a stringified boolean could satisfy the write-confirmation gate.
- **That shim must stay invisible to clients.** It rebuilds Zod nodes from their `_def` precisely so descriptions and array checks survive, and the SDK's zod-v3 conversion emits the inner schema for a `ZodEffects`, so the published JSON Schema is unchanged. Note *where* that last property comes from, because it is the thing that would break silently: zod-to-json-schema's **`effectStrategy` default** of `"input"` — not `pipeStrategy`, the neighbouring option the SDK actually sets (that one governs `ZodPipeline`). So don't trust it, check it: `npm run verify:schemas` registers every tool a second time *without* the shim and deep-compares all 60 published `inputSchema`s, which fails CI on a lossy rebuild, on a changed library default, or on a zod-v4 migration that flips the SDK's conversion branch.
- **Never render a GL account as a bare code.** Xero returns *only* `accountCode` on line items and journal lines — the name lives on the separate chart-of-accounts resource — so a renderer that prints the code alone hands the reader `2230` and nothing else, and an assistant relaying that output has no name it could possibly use. Every emission goes through `formatAccountRef(code, accountNames)` (`src/helpers/account-names.ts`) to produce `Accrued Payroll (2230)`; the code stays in parens because tool schemas still require `accountCode` and dropping it would force a second lookup before every write. The map comes from `getAccountNameMap()`, memoized 5 min per child process, which **never throws** — a failed lookup yields an empty map and callers fall back to the bare code, because account naming must not be able to break a list or a write preview. Note the loader returns `null` on failure rather than an empty map: a genuinely empty chart of accounts is a real, cacheable answer, and conflating the two would refetch forever for such an org. `npm run verify:account-names` covers the happy path, that degradation, the write-preview legend, and the cache itself (TTL reuse, concurrent de-duplication, no-cache-on-failure) against a stub loader, so it stays offline. Its regression guard matches **any** `${…}` interpolation of an `accountCode` not routed through `formatAccountRef` — deliberately broader than one fixed label, because the first version checked only `` `Account Code: ${…}` `` and missed `` `on account ${accountCode}` `` in the list-invoices/list-manual-journals filter summaries, which is this very bug.
- **Register tools via `server.registerTool({ inputSchema })`, never the positional `server.tool()` overload** — see the comment in `src/tools/tool-factory.ts` for the silent empty-schema failure that motivated it.

## Auth invariants (don't regress)

- **A 401 from Xero re-authenticates and retries once, via a Proxy over `accountingApi` and `payrollNZApi`** (`src/clients/auth/mcp-xero-client.ts`). That is an odd-looking mechanism chosen because there is no alternative: all 78 call sites call those generated methods directly with no funnel, xero-node exposes no auth hook, and the generated methods use the **global** axios default rather than a per-client instance, so there is no interceptor to register that would not also affect every other axios user in the process.
- **Never add a `set` trap to that Proxy.** `accessToken` on a generated api object is a write-only setter on the prototype (`set accessToken(token) { this.authentications.OAuth2.accessToken = token }`) with no getter, which is why reading it back returns `undefined`. With only a `get` trap the assignment in `setAccessToken()` reaches that setter correctly. A `set` trap writing straight to the target would bypass it, and **every token refresh would silently stop taking effect** while the code still looked right. `npm run verify:auth-recovery` asserts the write survives.
- **Retry on 401 only, never 403.** Xero uses 403 for a scope the connection lacks and for org permission problems, which no new token fixes, and unlike a 401 it can follow work Xero already accepted — which matters because the retry re-sends the body and this server creates invoices, credit notes and payments.
- **`authenticate()`'s cache gate must test for an actual token.** It used to read `this.tenantId && this.accessTokenExpiresAt > …`. `tenantId` means *which Xero org*, not *do I hold a credential* — and this class has no access-token field, because the token lives in xero-node's private `_tokenSet`. So a known tenant plus a future timestamp skipped the refresh with no usable token behind it. `hasUsableAccessToken()` now also checks `readTokenSet()?.access_token`.
- **`invalidateAccessToken()` must not clear the refresh token.** Clearing it makes `usedCachedToken` false on the next attempt, which disables the `invalid_grant` retry that re-reads Secret Manager — turning a recoverable rotation race into a "re-run the bootstrap script" dead end.
- **The refresh-token secret is read as newest-ENABLED, and only strictly older versions are disabled.** This matters more here than in the sibling servers: Xero's rotation is single-use, so the stored secret is the only copy of a live credential. `versions/latest` resolves regardless of state and throws `FAILED_PRECONDITION` on a disabled version instead of falling back; and the old "disable everything except mine" rule let two overlapping instances — the rolling-deploy window this file already warns about — each disable the other's newer version, leaving no enabled version and a user who cannot authenticate at all. `versionsToDisable` in `src/clients/auth/token-recovery.ts` makes that impossible by construction.

## Deployment

Production is the shared Cloud Run service **`xero-mcp`** (GCP project `internal-mcps-496022`, region `us-central1`), at `https://xero-mcp-1074937591843.us-central1.run.app`.

**How it deploys:** merging a PR into **`swiftotter/main`** triggers `.github/workflows/deploy.yaml`, which builds the Docker image **on the runner** and `docker push`es it to Artifact Registry (`us-central1-docker.pkg.dev/internal-mcps-496022/xero-mcp/server`), then rolls out Cloud Run. The image builds from `src/` (Docker runs `npm run build`), so **`dist/` is not committed**.

> Note: build on the runner + push to Artifact Registry — **not** `gcloud builds submit`. Cloud Build's source-staging upload fails in CI ("forbidden … serviceusage.services.use") regardless of SA roles; the runner build only needs `artifactregistry.writer`, which the deploy SA already has.

**Scaling is pinned to a single instance — and the merge does NOT set it.** The service must run at **`--max-instances=1 --min-instances=1 --memory=2Gi`**. `max-instances=1` is a correctness requirement, not a cost knob: the server holds one long-lived child process per user, and Xero issues single-use rotating refresh tokens, so two instances refreshing the same user's token would invalidate each other (`invalid_grant`, a permanent auth break). `deploy.yaml` only runs `gcloud run services update --image`, which **preserves** the existing revision's scaling/memory — so changing these values in `scripts/deploy-shared.sh` does **not** ship them on merge. Apply them **out-of-band, BEFORE merging** any change that assumes a single instance, as a project Owner:
> ```bash
> gcloud run services update xero-mcp --project=internal-mcps-496022 --region=us-central1 \
>   --max-instances=1 --min-instances=1 --memory=2Gi --quiet
> ```
> Verify after: `gcloud run services describe xero-mcp --project=internal-mcps-496022 --region=us-central1 --format="value(spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'])"` → `1`.

**Process:**
1. Branch from `swiftotter/main`; push the branch to the **`swiftotter`** remote — not `origin` (that's the read-only XeroAPI upstream).
2. Open a PR against `swiftotter/main`. Direct push to `main` is blocked.
3. The merge is the deploy. A human merges (not automation).

**Verify a deploy actually shipped** — don't trust "merged" alone:
```bash
gcloud run services describe xero-mcp --project=internal-mcps-496022 --region=us-central1 \
  --format="value(status.latestReadyRevisionName, spec.template.spec.containers[0].image)"
curl -s https://xero-mcp-1074937591843.us-central1.run.app/status   # -> {"status":"ok"}
```

**Manual deploy (fallback, run as a project Owner):** same build-on-runner approach as CI — do **not** use `gcloud builds submit`.
```bash
IMG=us-central1-docker.pkg.dev/internal-mcps-496022/xero-mcp/server:$(git rev-parse --short HEAD)
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
docker build --platform=linux/amd64 -t "$IMG" .
docker push "$IMG"
gcloud run services update xero-mcp --project=internal-mcps-496022 --region=us-central1 --image="$IMG" --quiet
```
