# Automatic Security Review — SwiftOtter MCP Servers

Instructions for an automated reviewer (a Claude agent in CI, the `/security-review`
command, or a reviewer subagent) that inspects every change to **any SwiftOtter MCP
server**. **Security is the priority.** A change that is functionally correct but opens
a security hole must be blocked.

Our MCP servers share an architecture (public Cloud Run service, app-layer OAuth, a
per-user child process holding a per-user upstream credential, secrets in the process
environment). This file encodes the threat model and the vulnerability classes that
follow from that architecture. The **Xero MCP** is the reference implementation and
appears throughout as the worked example; when reviewing another MCP, map the example
file/symbol names (`local-file-access.ts`, `childEnv()`, `XERO_MCP_DISABLE_LOCAL_FILES`,
the Xero `where` clause, etc.) to that repo's equivalents — the *principle* is what
transfers, not the exact identifier.

Read **§1 Threat model** before judging anything — most false positives come from not
understanding who the attacker is and what they already have.

---

## 0. How to run and what to produce

- **Scope:** review only the change under inspection — the branch diff
  (`git diff <base>...HEAD`) or the working-tree diff. Do not re-litigate pre-existing
  code unless the diff makes it exploitable. Pre-existing issues you happen to notice go
  in a separate "pre-existing / out of scope" note, never as a blocking finding.
- **Reporting threshold: Medium and above only.** Do **not** report Low or informational
  findings (see §4 for what counts as Low). If the worst you can say about something is
  "defense in depth" or "hardening," stay silent.
- **Confidence bar:** only flag a vulnerability you are **≥ 0.8** confident is real and
  exploitable under §1. Below that, stay silent. Better to miss a theoretical issue than
  to flood the PR.
- **Output (per finding):** `severity` (Medium / High / Critical) · `category` · `file:line`
  · what the change does · concrete exploit scenario (who attacks, with what input, gaining
  what) · fix · confidence.
- **Verdict:** `PASS` (no High/Critical; any Mediums acknowledged) or `FAIL` (≥1 unmitigated
  High/Critical). Write the verdict + evidence to `.code-reviews/security-review.json`.
- **Fail closed:** if you cannot determine whether a data flow is safe, treat it as unsafe
  and ask for the missing context rather than passing.

---

## 1. Threat model (READ FIRST — this is what makes findings accurate)

A SwiftOtter MCP server is typically a **public, `--allow-unauthenticated` Cloud Run
service** fronted by an app-layer OAuth 2.0 server. It generally runs in **two very
different deployment modes**, and almost every control depends on which mode is in play:

| | Hosted (Cloud Run) | Local (Claude Desktop, stdio) |
|---|---|---|
| Users | **Many, mutually untrusted** | One, the developer (trusted) |
| Secrets in process env | Yes — incl. the token-signing secret | The dev's own creds |
| Local filesystem access from tool args | **Must be forbidden** | **Intended feature** |
| Signalled by | a hosted-mode flag (Xero MCP: `XERO_MCP_DISABLE_LOCAL_FILES=1`, set by the parent on each child) | flag unset |

Key facts an attacker model depends on:

1. **Each authenticated user supplies their own upstream credential** (e.g. a Xero refresh
   token with full scope; for another MCP, its own provider token) and all upstream API
   calls run with *that* credential. A user acting on **their own** provider data through
   intended functionality is **not** a vulnerability — they can already do it directly with
   the provider. The boundary that matters is **cross-user** and **server compromise**.
2. **The token-signing secret is the master key.** It is the symmetric secret (Xero MCP:
   `MCP_JWT_SECRET`) that signs *every* user's access token. Anything that can leak it
   (reading process env, logging it, baking it into an image, returning it in a response)
   ⇒ an attacker forges a token for any user ⇒ **full cross-user account takeover**. This is
   the single highest-value target. Treat any new path to it as Critical.
3. **Per-user isolation** runs through the session handler: one child process per user, the
   JWT `sub` selects which user's secret (e.g. `xero-refresh-token-<sub>`) it loads. Any
   confusion of `sub`, reuse of a session across users, or path injection into the secret
   name crosses that boundary.
4. **The deploy SA backs the public service**, so any RCE / SSRF-to-metadata in the service
   yields that SA's GCP token — IAM scope on that SA is a real blast-radius control.

---

## 2. Priority vulnerability classes

Ordered by how badly they bite. The first three are how the real Criticals in the Xero MCP
happened — scrutinize any diff that touches them.

### A. Filesystem access from tool arguments  — *(Critical when reachable in hosted mode)*
Any handler that turns a tool argument into a path and reads/writes it.
- **Trigger to inspect:** new or changed `fs.readFile/writeFile/createReadStream/createWriteStream/mkdir`,
  `path.resolve`/`path.join` on an argument, or any "upload/download/attachment/export/import/file" tool.
- **Required mitigations:**
  - The path must be **refused in hosted mode** (the mode flag from §1) — Xero MCP reference:
    `src/helpers/local-file-access.ts` + the pattern in `create-xero-attachment.handler.ts`
    (read) and `get-xero-attachment.handler.ts` (write).
  - In local mode where the path is allowed, a **write** tool must still be gated (see §C).
- **Why:** an unguarded read of `/proc/self/environ` leaks the signing secret (→ takeover); an
  unguarded write to the child entrypoint (e.g. `/app/dist/index.js`) overwrites it (→ RCE on next spawn).
- **FAIL** any new arg-driven filesystem path that is not gated on the hosted-mode flag.

### B. Secret isolation in child processes — *(Critical)*
Anything touching how the session handler builds the child environment.
- **Trigger:** edits to the child-env builder (Xero MCP: `childEnv()` in `mcp-handler.ts`), the env
  allowlist/denylist, the child transport `env`, or any new env var added to the deploy.
- **Required:** the child env is an **allowlist**, and the token-signing secret must never be
  forwarded (and should be on an explicit denylist). Reverting to `...process.env` / a wholesale
  copy is a **FAIL**. Adding a new *secret* to the child is a FAIL unless the child genuinely needs
  it and it isn't cross-user (a provider *app* secret the child needs is fine; a cross-user signing
  key is not).
- Also flag: any secret written to logs (`console.*`), returned in a tool/HTTP response, or put in
  an error message. Logging URLs / `sub` / token *type* is fine; logging token/secret *values* is a FAIL.

### C. Write-tool gating & annotations — *(High)*
Every state-changing or filesystem-writing MCP tool must be registered as a **write** tool
(not `readOnlyHint: true`) and wrapped by the write-confirmation gate (Xero MCP:
`requireWriteConfirmation` in `tool-factory.ts`).
- **Trigger:** new tool, changes to the tool factory/registration, a `Get`/`List`/read tool that
  performs a write (the `get-attachment` lesson — it writes a file, so it is a write tool).
- **FAIL** a tool that mutates provider state or the filesystem while annotated read-only or un-gated.
- Note: the write-confirmation gate is a UX/agent confirmation, **not** an authorization boundary —
  do not rely on it as a security control, and do not file its bypass (`confirm:true`) as a vuln.

### D. Authn / authz / session boundaries — *(Critical/High)*
The OAuth server, the session handler, and the auth clients.
- `jwt.verify` must **pin `algorithms`** to the signing algorithm and enforce `issuer`, `audience`,
  `exp`, `typ` (access vs refresh), and a validated `sub`.
- `sub` must be validated **before** being interpolated into the Secret Manager resource path
  (e.g. `…/secrets/xero-refresh-token-<sub>`) — unvalidated `sub` = path/resource injection across users.
- Session reuse must reject `session.sub !== sub` (no cross-user session reuse/fixation).
- OAuth: PKCE required; `redirect_uri` hard-allowlisted; auth codes & `state` single-use with TTL;
  no open redirect; any synthetic/fallback client path must not depend on a trusted `client_id`.
- **No auth decision may trust** `X-Forwarded-*`, `Host`, or other request-controlled headers.
- Child spawn must use an args **array** (no shell), and no user-derived value may reach a shell.

### E. Upstream-API query / filter injection — *(severity depends on blast radius)*
Interpolating tool input into an upstream query/filter/search string (e.g. a Xero `where`/`order`
clause, or another provider's query DSL).
- Require escaping of quotes/backslashes; flag raw interpolation **only if** the injected query can
  reach **another user's / another tenant's** data → then it is High.
- If the query is always scoped to the **caller's own** account/tenant (as Xero `where` is), there is
  no boundary crossing and the caller already owns that data → this is at most Low → **below threshold,
  do not report** (see §4). Never inflate a same-account injection to High.

### F. SSRF / outbound requests — *(High only if host/protocol is user-controlled)*
Outbound calls should target fixed provider hosts. Flag any new outbound request whose **host or
protocol** is derived from user input. A user-controlled **path only** (fixed host) is not an SSRF finding.

### G. Deploy & IAM — *(High)*
The deploy script(s) and `.github/workflows/*.yaml`.
- **Least privilege:** no project-wide `roles/secretmanager.admin` (or equivalent broad role).
  Conditional IAM bindings must key on the **project number** (`projects/<NUMBER>/secrets/...`) —
  the ID form silently matches nothing.
- **No silent broadening:** reject `|| ... --condition=None` fallbacks and any pattern that downgrades
  to a wider grant on failure. Scripts must `set -euo pipefail` and fail loudly.
- **GitHub Actions:** require `permissions: contents: read` (least privilege), `persist-credentials: false`
  on checkout, and bind deploy jobs to a protected environment (e.g. `production`). Flag untrusted input
  (PR title/branch/issue body) interpolated into a `run:` block. Prefer keyless Workload Identity
  Federation over a long-lived `*_SA_KEY`; flag a static SA key as a finding with the WIF remediation.
- **Org policy:** workflows should use `runs-on: self-hosted`. Flag `*-latest` runners — but note
  whether a self-hosted runner is actually registered before recommending the switch (switching with
  none registered halts CI/deploys).

### H. Docker / build / supply chain — *(High)*
- Image must run as non-root; no secrets/`.env`/credentials copied in; specific-path `COPY`, never `COPY . .`.
- `.dockerignore` must exclude credential material (`.env*`, `gha-creds-*.json`, `.claude`, `bin`, etc.).
- `package.json`: scrutinize new/changed `postinstall`/lifecycle scripts and new dependencies that
  don't match an import (typosquats). Do **not** report outdated-dependency CVEs — Dependabot owns those.

---

## 3. What is NOT a finding (false-positive suppression)

Do not report these — they are either intended, out of model, or already correct.

1. A user reading or modifying **their own** provider data via intended functionality (they hold a
   full-scope credential for it).
2. A **change-control rail** that isn't an authorization boundary — e.g. the Xero MCP's
   "recently created by Claude" audit-note guard (`recently-created-by-claude.ts`). The actual write
   runs with the caller's own token; bypassing the rail grants nothing new, and it fails closed.
3. The write-confirmation gate being satisfiable with `confirm:true` — it is an agent/human-in-the-loop
   prompt, not a security control.
4. **Local (stdio) mode** arbitrary file access — that is the intended feature in that mode. Only flag
   filesystem access reachable in **hosted** mode (the §1 flag set).
5. Attacks that require controlling an **environment variable** or CLI flag — env/flags are trusted.
6. DoS / rate-limiting / resource exhaustion; log spoofing (logging unsanitized input); secrets-on-disk
   that are otherwise secured; outdated-dependency CVEs.
7. UUIDs treated as guessable — assume they are unguessable.

---

## 4. Severity rubric and the reporting threshold

Report **Medium and above**. Definitions:

- **Critical** — leaks the token-signing secret or another cross-user secret; cross-user account
  takeover; RCE / arbitrary code execution in the service; authentication bypass.
- **High** — arbitrary read/write of server files in hosted mode; privilege escalation; broad IAM
  grant on the deploy/runner SA; static deploy credential reachable off the deploy gate; missing
  auth on a state-changing endpoint.
- **Medium** — a concrete, conditional issue with real impact (e.g. a write tool annotated read-only,
  a missing `sub` validation that is reachable). Only report Mediums that are obvious and concrete.

**Below threshold — DO NOT report** (listed only so you don't mis-escalate them):
- Low / informational findings of any kind.
- Same-account / same-tenant upstream query injection (§2.E) — no boundary crossed.
- Missing algorithm pinning where the key is symmetric and no asymmetric key exists (not exploitable).
- `.dockerignore` hygiene, defense-in-depth gaps, "would be nice to also…" hardening.

If the only issues in a diff are below threshold, the verdict is **PASS** with no findings.

---

## 5. Mandatory gate before a security PASS

Confirm these ran clean for the change (or run them):

- `npm run lint` and `npm run build` (or the repo's equivalents) — clean.
- The repo's **security verification scripts**. The Xero MCP provides:
  - `npm run verify:fs-guard` (`scripts/verify-attachment-fs-guard.mjs`) — proves the hosted-mode
    filesystem guard still refuses arg-driven read/write.
  - `node scripts/verify-confirmation-gate.mjs` — write tools gated, read tools not.

  Each MCP should ship equivalents for its own write / filesystem / auth guards; run whatever exists.
- Every §2 control touched by the diff is satisfied; §3 exclusions and the §4 threshold applied.

Record the result in `.code-reviews/security-review.json`. A `FAIL` blocks merge; a human merges,
the reviewer never does.

---

## Appendix — wiring it to run automatically

This file is the *instructions*. To make the review automatic on every PR in an MCP repo, add a
workflow that invokes Claude with this file as the prompt context. Template (enable once an
`ANTHROPIC_API_KEY` secret exists and the runner question in §2.G is resolved):

```yaml
# .github/workflows/security-review.yaml  (TEMPLATE — not enabled by default)
name: Security review
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write   # to post the review as a comment
jobs:
  review:
    # Org policy is self-hosted; only switch from ubuntu-latest once a runner is registered.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - name: Run Claude security review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Diff this PR against its base and have Claude review it using THIS file as the rubric.
          git diff "origin/${{ github.base_ref }}...HEAD" > /tmp/pr.diff
          npx -y @anthropic-ai/claude-code -p \
            "Act as the automated security reviewer. Follow .github/security-review.md exactly.
             Review the diff in /tmp/pr.diff. Report only Medium-and-above findings. Output the
             findings and the PASS/FAIL verdict, and write evidence to .code-reviews/security-review.json." \
            --allowedTools "Read,Grep,Glob,Bash(git diff:*)" \
            > review.md
      # Post review.md as a PR comment and fail the job if the verdict is FAIL
      # (e.g. with actions/github-script + a grep for '"result": "FAIL"').
```

Notes before enabling:
- Provide `ANTHROPIC_API_KEY` as a **`production` environment** secret, not a repo secret, so it is
  not readable from arbitrary branches (same exposure class as §2.G).
- Resolve the `runs-on` policy (§2.G) — repos with no self-hosted runner registered must keep the
  GitHub-hosted runner until one exists.
- This same file and workflow drop into any SwiftOtter MCP repo unchanged; only the §5 verification
  script names differ per repo.
- For local / pre-push use, run the equivalent on demand: `/security-review` (the built-in skill) or
  the `swiftotter-build:security-reviewer` agent, both pointed at this file as the rubric.
