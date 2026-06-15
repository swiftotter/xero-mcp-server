/**
 * Per-user child-process pool for the stateless MCP transport.
 *
 * Each user (identified by their verified JWT `sub`) gets exactly ONE long-lived
 * xero-mcp-server child process, spawned lazily on first use and reused across
 * many short-lived per-request HTTP transports. This is what lets ANY instance
 * serve ANY user without a pre-existing in-RAM session: instance replacement
 * (deploy or Cloud Run recycle) just triggers a sub-second lazy respawn on the
 * next request, instead of the client's stale mcp-session-id getting a 404.
 *
 * EXACTLY ONE child per user is a hard requirement, not an optimization. Xero
 * issues single-use rotating refresh tokens (see authorization-code-xero-client),
 * so two children sharing one user's refresh-token lineage would invalidate each
 * other -> invalid_grant -> a *permanent* auth break. `acquire` uses single-flight
 * spawning, and the service runs at max-instances=1, to guarantee it.
 *
 * The child is driven through the SDK `Client` abstraction (not raw stdio piping):
 * one long-lived child multiplexed across many concurrent per-request transports
 * needs the Client's own JSON-RPC id space + response-handler map for correct
 * request/response correlation, and its clean ConnectionClosed rejection when the
 * child dies. Raw piping (the old session model) only worked because one HTTP
 * transport mapped 1:1 to one child.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { DISABLE_LOCAL_FILES_ENV } from "./helpers/local-file-access.js";

// Each child is a full Node process (secret-manager + axios + xero-node), so
// resident memory, not CPU, is the binding constraint on the single 2Gi instance.
// Keep this conservative and size it against MEASURED per-child RSS; raise via the
// MCP_MAX_CHILDREN env var (or bump instance memory) once that's known. When the
// cap is hit the pool rejects with POOL_BUSY rather than risking an OOM SIGKILL,
// which would mass-disconnect every active user on the instance.
const DEFAULT_MAX_CHILDREN = 10;
const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const REAP_INTERVAL_MS = 60_000;

// JSON-RPC error codes surfaced to the external client. We stay in the
// implementation-defined server-error range and avoid the SDK's reserved codes
// (-32000 ConnectionClosed, -32001 RequestTimeout) to keep them distinguishable.
export const SPAWN_FAILED_CODE = -32002;
export const POOL_BUSY_CODE = -32003;

/** Error carrying a JSON-RPC code, so the handler can relay it verbatim. */
export class ChildPoolError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "ChildPoolError";
  }
}

/**
 * A live per-user child. Consumers (the request handler) use `client` to relay
 * JSON-RPC calls and the cached `serverCapabilities` / `serverInfo` /
 * `instructions` to synthesize the external `initialize` result. The remaining
 * fields are pool bookkeeping.
 */
export type ChildHandle = {
  readonly sub: string;
  readonly client: Client;
  readonly transport: StdioClientTransport;
  serverCapabilities: ServerCapabilities | undefined;
  serverInfo: Implementation | undefined;
  instructions: string | undefined;
  /** Outstanding relayed requests; a child is never reaped while > 0. */
  inFlight: number;
  lastActivityAt: number;
  closed: boolean;
  /** Idempotent, re-entry-guarded teardown. */
  dispose: () => void;
};

export type ChildPoolConfig = {
  serverEntrypoint: string;
  projectId: string;
  xeroAppClientId: string;
  xeroAppClientSecret: string;
  /** Defaults: MCP_MAX_CHILDREN env, else 16. */
  maxChildren?: number;
  /** Defaults: 10 minutes. */
  idleTtlMs?: number;
};

export class ChildPool {
  private readonly children = new Map<string, ChildHandle>();
  // Single-flight: a sub's spawn promise lives here from the synchronous moment
  // acquire() decides to spawn until it settles, so concurrent first-requests
  // for one user share one spawn instead of racing two children into existence.
  private readonly pending = new Map<string, Promise<ChildHandle>>();
  private readonly reaper: ReturnType<typeof setInterval>;
  private readonly maxChildren: number;
  private readonly idleTtlMs: number;
  private closing = false;

  constructor(private readonly config: ChildPoolConfig) {
    const envMax = Number(process.env.MCP_MAX_CHILDREN);
    const candidate =
      config.maxChildren ??
      (Number.isFinite(envMax) && envMax >= 1 ? envMax : DEFAULT_MAX_CHILDREN);
    this.maxChildren =
      Number.isFinite(candidate) && candidate >= 1
        ? candidate
        : DEFAULT_MAX_CHILDREN;
    this.idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  /**
   * Get-or-spawn this user's child and mark a request in flight. The caller MUST
   * pair every successful acquire with exactly one release() (use try/finally).
   */
  async acquire(sub: string, name: string): Promise<ChildHandle> {
    if (this.closing) {
      throw new ChildPoolError("server shutting down", POOL_BUSY_CODE);
    }

    const existing = this.children.get(sub);
    if (existing && !existing.closed) {
      existing.inFlight++;
      existing.lastActivityAt = Date.now();
      return existing;
    }

    let spawn = this.pending.get(sub);
    if (!spawn) {
      spawn = this.spawn(sub, name);
      this.pending.set(sub, spawn);
      // Clear the slot once it settles, regardless of outcome.
      void spawn.catch(() => undefined).finally(() => {
        if (this.pending.get(sub) === spawn) this.pending.delete(sub);
      });
    }

    const handle = await spawn;
    handle.inFlight++;
    handle.lastActivityAt = Date.now();
    return handle;
  }

  release(handle: ChildHandle): void {
    handle.inFlight = Math.max(0, handle.inFlight - 1);
    handle.lastActivityAt = Date.now();
  }

  /** Close a single user's child if it is idle (used by DELETE /mcp). */
  evict(sub: string): void {
    const handle = this.children.get(sub);
    if (handle && handle.inFlight === 0) handle.dispose();
  }

  /** Close every child. Awaits the underlying transport closes (for SIGTERM). */
  async closeAll(): Promise<void> {
    this.closing = true;
    clearInterval(this.reaper);
    const handles = [...this.children.values()];
    await Promise.allSettled(
      handles.map(async (h) => {
        h.dispose();
        await Promise.allSettled([h.client.close(), h.transport.close()]);
      }),
    );
  }

  /** Test/observability helper. */
  get size(): number {
    return this.children.size;
  }

  private async spawn(sub: string, name: string): Promise<ChildHandle> {
    this.enforceCapacity();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.config.serverEntrypoint],
      env: {
        ...childEnv(),
        XERO_APP_CLIENT_ID: this.config.xeroAppClientId,
        XERO_APP_CLIENT_SECRET: this.config.xeroAppClientSecret,
        XERO_REFRESH_TOKEN_SECRET_NAME: `projects/${this.config.projectId}/secrets/xero-refresh-token-${sub}`,
        XERO_USER_NAME: name,
        // The child runs untrusted multi-user tool calls and shares the parent's
        // secrets via its environment. Forbid local-filesystem tool args so a
        // caller can't read /proc/self/environ or overwrite server code.
        [DISABLE_LOCAL_FILES_ENV]: "1",
      },
      stderr: "inherit",
    });

    const client = new Client(
      { name: "xero-mcp-pool", version: "1.0.0" },
      { capabilities: {} },
    );

    const handle: ChildHandle = {
      sub,
      client,
      transport,
      serverCapabilities: undefined,
      serverInfo: undefined,
      instructions: undefined,
      inFlight: 0,
      lastActivityAt: Date.now(),
      closed: false,
      dispose: () => undefined,
    };

    // Re-entry-guarded teardown. The June-8 recursion crash: closing one
    // transport fires its onclose, which closed the other, which fired ITS
    // onclose ... until the stack overflowed and the unhandled rejection killed
    // the instance. We set `closed` and detach the handler BEFORE closing.
    handle.dispose = () => {
      if (handle.closed) return;
      handle.closed = true;
      client.onclose = undefined;
      if (this.children.get(sub) === handle) this.children.delete(sub);
      void client.close().catch(() => undefined);
      void transport.close().catch(() => undefined);
    };
    client.onclose = handle.dispose;
    client.onerror = (err) =>
      console.error("[child-pool] client error", sub, err);

    try {
      // connect() starts the transport and performs the initialize handshake.
      await client.connect(transport);
    } catch (err) {
      handle.dispose();
      const detail = (err as Error)?.message ?? String(err);
      console.error("[child-pool] spawn failed", { sub, detail });
      throw new ChildPoolError(
        `Failed to start Xero MCP child for this user: ${detail}`,
        SPAWN_FAILED_CODE,
      );
    }

    handle.serverCapabilities = client.getServerCapabilities();
    handle.serverInfo = client.getServerVersion();
    handle.instructions = client.getInstructions();

    this.children.set(sub, handle);
    console.log("[child-pool] child ready", {
      sub,
      pid: transport.pid,
      size: this.children.size,
    });
    return handle;
  }

  private enforceCapacity(): void {
    // Count in-flight spawns too (they aren't in `children` yet) so a burst of
    // distinct new users can't overshoot the cap.
    if (this.children.size + this.pending.size < this.maxChildren) return;
    // At capacity: evict the least-recently-used IDLE child to make room.
    let lru: ChildHandle | undefined;
    for (const handle of this.children.values()) {
      if (handle.inFlight > 0) continue;
      if (!lru || handle.lastActivityAt < lru.lastActivityAt) lru = handle;
    }
    if (lru) {
      console.log("[child-pool] evicting idle LRU child for capacity", {
        sub: lru.sub,
        max: this.maxChildren,
      });
      lru.dispose();
      return;
    }
    // Every child is busy — refuse rather than OOM-kill the instance, which
    // would mass-disconnect every active user on it.
    console.warn("[child-pool] at capacity, rejecting request", {
      max: this.maxChildren,
    });
    throw new ChildPoolError(
      `server busy: ${this.maxChildren} users active, retry shortly`,
      POOL_BUSY_CODE,
    );
  }

  private reap(): void {
    const now = Date.now();
    for (const handle of this.children.values()) {
      if (handle.inFlight === 0 && now - handle.lastActivityAt > this.idleTtlMs) {
        console.log("[child-pool] reaping idle child", { sub: handle.sub });
        handle.dispose();
      }
    }
  }
}

// Env passed through to each per-user child. We deliberately do NOT copy the
// whole parent process.env: it holds MCP_JWT_SECRET — the HS256 key that signs
// EVERY user's access token — so leaking it (e.g. via a child reading its own
// /proc/self/environ) would let an attacker forge tokens for any user. The
// child authenticates only to Xero and Secret Manager, so it needs system /
// Node runtime basics plus Google ADC vars (ADC itself works off the metadata
// server and needs no env). The Xero credentials it needs are set explicitly by
// the caller; everything sensitive and parent-only is excluded.
const CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "PWD",
]);
const CHILD_ENV_ALLOWED_PREFIXES = [
  "LC_",
  "NODE_", // NODE_OPTIONS, NODE_EXTRA_CA_CERTS, ...
  "SSL_", // custom CA roots
  "GRPC_", // @grpc/grpc-js tuning used by Secret Manager
  "GOOGLE_", // ADC / project detection
  "GCLOUD_",
  "GCP_", // GCP_PROJECT
  "GCE_", // GCE_METADATA_HOST
  "GAE_",
  "CLOUDSDK_",
  "K_", // Cloud Run-injected K_SERVICE / K_REVISION / ...
];
// Never forward these to a child even if a future allowlist entry would match.
const CHILD_ENV_DENYLIST = new Set(["MCP_JWT_SECRET"]);

export function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (CHILD_ENV_DENYLIST.has(k)) continue;
    if (
      CHILD_ENV_ALLOWLIST.has(k) ||
      CHILD_ENV_ALLOWED_PREFIXES.some((prefix) => k.startsWith(prefix))
    ) {
      out[k] = v;
    }
  }
  return out;
}
