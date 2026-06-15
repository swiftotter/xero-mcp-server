/**
 * Cloud Run entrypoint for the shared MCP service.
 *
 * Composes:
 *   - GET /healthz (open)
 *   - GET /callback (Xero redirect target)
 *   - MCP SDK auth router (/authorize, /token, /register, /revoke, /.well-known)
 *   - JWT-gated, stateless MCP transport route (POST/GET/DELETE /mcp)
 *
 * Env vars (all required):
 *   PUBLIC_URL                       — outward-facing URL of this service (e.g. https://xero-mcp-xxx.run.app)
 *   GCP_PROJECT                      — project id, used for Secret Manager paths
 *   XERO_APP_CLIENT_ID               — mounted from Secret Manager xero-app-id
 *   XERO_APP_CLIENT_SECRET           — mounted from Secret Manager xero-app-secret
 *   MCP_JWT_SECRET                   — mounted from Secret Manager mcp-jwt-secret
 *   PORT                             — Cloud Run default 8080
 *   MCP_SERVER_ENTRYPOINT (optional) — path to dist/index.js, defaults to /app/dist/index.js
 */
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import express, { type Request, type Response } from "express";

import { buildMcpRouter } from "./mcp-handler.js";
import {
  XeroChainedOAuthProvider,
  buildMcpAuthRouter,
  createXeroCallbackRouter,
} from "./oauth-server.js";

const ALLOWED_ORIGINS = new Set([
  "https://claude.ai",
  "https://claude.com",
]);

// Inline favicon shown in Claude Desktop's connector list and browser tabs.
// Xero brand blue with a white X glyph; SVG accepted by Claude Desktop and
// every modern browser when served as image/svg+xml at /favicon.ico.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="32" fill="#13B5EA"/>
  <path d="M22 22 L42 42 M42 22 L22 42" stroke="white" stroke-width="6" stroke-linecap="round"/>
</svg>`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function corsMiddleware(
  req: Request,
  res: Response,
  next: (err?: unknown) => void,
): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

async function main(): Promise<void> {
  const publicUrl = requireEnv("PUBLIC_URL").replace(/\/$/, "");
  const projectId = requireEnv("GCP_PROJECT");
  // Trim trailing whitespace/newlines that Secret Manager preserves verbatim
  // (e.g. `openssl rand -hex 32 | gcloud secrets create ...` leaves a \n).
  const xeroClientId = requireEnv("XERO_APP_CLIENT_ID").trim();
  const xeroClientSecret = requireEnv("XERO_APP_CLIENT_SECRET").trim();
  const jwtSecret = requireEnv("MCP_JWT_SECRET").trim();
  const port = Number(process.env.PORT ?? 8080);
  const serverEntrypoint =
    process.env.MCP_SERVER_ENTRYPOINT ?? "/app/dist/index.js";

  const secretManager = new SecretManagerServiceClient();

  const provider = new XeroChainedOAuthProvider({
    xeroClientId,
    xeroClientSecret,
    callbackUrl: `${publicUrl}/callback`,
    jwtSecret,
    projectId,
    secretManager,
  });

  const app = express();
  app.disable("x-powered-by");
  // Cloud Run sits behind Google's load balancer; trust its X-Forwarded-* so
  // express-rate-limit and req.ip work, and to silence the validator errors.
  app.set("trust proxy", 1);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/status", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(FAVICON_SVG);
  });

  app.use(createXeroCallbackRouter(provider));
  app.use(
    buildMcpAuthRouter(
      provider,
      new URL(publicUrl),
      new URL(`${publicUrl}/mcp`),
    ),
  );
  const mcp = buildMcpRouter({
    provider,
    projectId,
    xeroAppClientId: xeroClientId,
    xeroAppClientSecret: xeroClientSecret,
    serverEntrypoint,
  });
  app.use(mcp.router);

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      next: (e?: unknown) => void,
    ) => {
      console.error("[entrypoint] unhandled error", err);
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({ error: "server_error" });
    },
  );

  const server = app.listen(port, "0.0.0.0", () => {
     
    console.log(`[entrypoint] listening on port ${port}, public URL ${publicUrl}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[entrypoint] received ${signal}, shutting down`);
    // Stop accepting new connections AND drain the per-user children in parallel.
    // We do NOT gate the drain behind server.close()'s callback: that fires only
    // once every open connection ends, which on a busy instance may not happen
    // within the budget. A child killed mid-refresh can leave a half-rotated
    // single-use Xero token (-> invalid_grant), so closing children cleanly must
    // not depend on idle HTTP. Exit when the drain finishes or the soft cap hits.
    server.close();
    void Promise.race([
      mcp.closeAll(),
      new Promise((resolve) => setTimeout(resolve, 8_000).unref()),
    ]).finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Defense-in-depth: a stray rejection/exception from a single session's
  // transport teardown (which fires outside the Express request lifecycle, so
  // the error middleware can't catch it) must not crash the instance and take
  // down every other in-flight session. Log and keep serving.
  process.on("unhandledRejection", (reason) => {
    console.error("[entrypoint] unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[entrypoint] uncaughtException", err);
  });
}

main().catch((err) => {
   
  console.error("[entrypoint] fatal", err);
  process.exit(1);
});
