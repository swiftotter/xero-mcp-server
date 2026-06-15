/**
 * JWT-gated, STATELESS MCP transport endpoint.
 *
 * Uses the Streamable HTTP transport (the current preferred transport per the
 * MCP spec, also what Claude's remote connector uses) in STATELESS mode
 * (sessionIdGenerator: undefined): no mcp-session-id is issued and none is
 * validated, so the server never returns `404 session_not_found`. That is the
 * whole point — a session id that survives an instance replacement (deploy or
 * Cloud Run recycle) is exactly what used to get rejected and surface to the
 * user as a disconnect.
 *
 * Per request:
 *   1. Validate the bearer JWT (mcp SDK's requireBearerAuth) → verified `sub`.
 *   2. `pool.acquire(sub)` get-or-(lazily-)spawns this user's long-lived child
 *      (see child-pool.ts), keyed by `sub` — NEVER by a client-supplied header.
 *   3. Create a FRESH stateless transport and `relay` each JSON-RPC message to
 *      the child via its SDK Client; relay the response back verbatim.
 *   4. Release the child and close the transport when the response is delivered.
 *
 * Instance replacement is therefore invisible: a request arriving at an instance
 * with an empty pool just triggers a sub-second lazy respawn.
 */
import { Request, Response, Router } from "express";

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ChildHandle, ChildPool, ChildPoolError } from "./child-pool.js";
import { XeroChainedOAuthProvider } from "./oauth-server.js";

// The child request can be a long-running Xero report; keep this well under
// Cloud Run's 3600s request timeout. Client disconnects abort sooner via the
// AbortController wired to the HTTP response.
const CHILD_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Relay any JSON-RPC result through untouched — we are a transparent proxy, not
// a semantic MCP client, so we don't validate the child's result shape.
const PassthroughResultSchema = z.object({}).passthrough();

type JsonRpcId = string | number | null;
type RpcError = { code: number; message: string; data?: unknown };

export type McpHandlerConfig = {
  provider: XeroChainedOAuthProvider;
  projectId: string;
  xeroAppClientId: string;
  xeroAppClientSecret: string;
  serverEntrypoint: string;
};

export type McpRouter = {
  router: Router;
  /** Drain every per-user child (call from the SIGTERM handler). */
  closeAll: () => Promise<void>;
};

export function buildMcpRouter(config: McpHandlerConfig): McpRouter {
  const router = Router();
  const pool = new ChildPool({
    serverEntrypoint: config.serverEntrypoint,
    projectId: config.projectId,
    xeroAppClientId: config.xeroAppClientId,
    xeroAppClientSecret: config.xeroAppClientSecret,
  });

  const bearerAuth = requireBearerAuth({ verifier: config.provider });

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    const sub = readSubFromAuth(req);
    if (!sub) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const name = readNameFromAuth(req);

    let handle: ChildHandle;
    try {
      handle = await pool.acquire(sub, name);
    } catch (err) {
      const rpcError = toRpcError(err);
      console.error("[mcp-handler] acquire failed", {
        sub,
        code: rpcError.code,
        message: rpcError.message,
      });
      writeJsonRpcError(res, jsonRpcIdOf(req.body), rpcError);
      return;
    }

    // A stateless transport must be fresh per request (the SDK throws if reused)
    // — that is what guarantees no session id is ever minted or validated.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const abort = new AbortController();
    const onClientGone = (): void => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClientGone);

    transport.onmessage = (msg: JSONRPCMessage): void => {
      void relay(handle, transport, msg, abort.signal);
    };

    try {
      await transport.start();
      // Resolves only after the response stream is fully delivered, so the
      // finally below runs after relay() has sent its reply — not before.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(
        "[mcp-handler] handleRequest threw",
        (err as Error)?.message,
      );
      if (!res.headersSent) {
        writeJsonRpcError(res, jsonRpcIdOf(req.body), toRpcError(err));
      }
    } finally {
      res.off("close", onClientGone);
      pool.release(handle);
      void transport.close().catch(() => undefined);
    }
  };

  // The child sends no server-initiated notifications, so there is no standalone
  // SSE stream to open. Refuse GET instead of leaving a dangling connection.
  const handleGet = (_req: Request, res: Response): void => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  };

  // Stateless: there is no session to delete. Best-effort free this user's idle
  // child so an explicit disconnect reclaims memory promptly.
  const handleDelete = (req: Request, res: Response): void => {
    const sub = readSubFromAuth(req);
    if (sub) pool.evict(sub);
    res.status(204).end();
  };

  router.post("/mcp", bearerAuth, handlePost);
  router.get("/mcp", bearerAuth, handleGet);
  router.delete("/mcp", bearerAuth, handleDelete);

  return { router, closeAll: () => pool.closeAll() };
}

async function relay(
  handle: ChildHandle,
  transport: StreamableHTTPServerTransport,
  msg: JSONRPCMessage,
  signal: AbortSignal,
): Promise<void> {
  const method = (msg as { method?: string }).method;
  const id = (msg as { id?: JsonRpcId }).id;
  const isRequest =
    typeof method === "string" && id !== undefined && id !== null;

  // Notifications carry no id and need no reply. We don't forward them: the
  // child is already initialized (so notifications/initialized is a no-op), and
  // id-bearing notifications like cancellations reference OUR id space, not the
  // child's.
  if (!isRequest) return;

  const params = (msg as { params?: unknown }).params as
    | Record<string, unknown>
    | undefined;

  // Answer the handshake and keepalive locally from the cached child handshake;
  // we do not re-initialize the shared long-lived child per external connection.
  if (method === "initialize") {
    await send(transport, {
      jsonrpc: "2.0",
      id,
      result: synthInitializeResult(handle, params),
    });
    return;
  }
  if (method === "ping") {
    await send(transport, { jsonrpc: "2.0", id, result: {} });
    return;
  }

  try {
    const result = await handle.client.request({ method, params }, PassthroughResultSchema, {
      signal,
      timeout: CHILD_REQUEST_TIMEOUT_MS,
    });
    await send(transport, { jsonrpc: "2.0", id, result });
  } catch (err) {
    // Always answer a request, even on failure, so the SSE stream closes and the
    // HTTP request doesn't hang. Child crash → ConnectionClosed; the pool's
    // onclose already dropped the handle, so the next request respawns.
    await send(transport, { jsonrpc: "2.0", id, error: toRpcError(err) });
  }
}

function synthInitializeResult(
  handle: ChildHandle,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const requested = params?.["protocolVersion"];
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  const result: Record<string, unknown> = {
    protocolVersion,
    capabilities: handle.serverCapabilities ?? {},
    serverInfo: handle.serverInfo ?? { name: "Xero MCP Server", version: "1.0.0" },
  };
  if (handle.instructions) result.instructions = handle.instructions;
  return result;
}

async function send(
  transport: StreamableHTTPServerTransport,
  msg: JSONRPCMessage,
): Promise<void> {
  try {
    await transport.send(msg);
  } catch (err) {
    console.error("[mcp-handler] transport.send failed", (err as Error)?.message);
  }
}

function toRpcError(err: unknown): RpcError {
  if (err instanceof ChildPoolError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof McpError) {
    return err.data !== undefined
      ? { code: err.code, message: err.message, data: err.data }
      : { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: ErrorCode.InternalError, message };
}

function writeJsonRpcError(
  res: Response,
  id: JsonRpcId,
  error: RpcError,
): void {
  if (res.headersSent) return;
  res.status(200).json({ jsonrpc: "2.0", id, error });
}

function jsonRpcIdOf(body: unknown): JsonRpcId {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function readSubFromAuth(req: Request): string | undefined {
  const sub = req.auth?.extra?.["sub"];
  return typeof sub === "string" ? sub : undefined;
}

function readNameFromAuth(req: Request): string {
  const name = req.auth?.extra?.["name"];
  return typeof name === "string" && name.length > 0 ? name : "Unknown user";
}
