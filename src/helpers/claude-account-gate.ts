import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import { AuthorizationCodeXeroClient } from "../clients/auth/authorization-code-xero-client.js";
import { xeroClient } from "../clients/xero-client.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import { ensureError } from "./ensure-error.js";

/**
 * Writes are only allowed from a Xero user that exists for Claude alone —
 * `sarah+claude@swiftotter.com`, `jesseclaude2@swiftotter.com` — never someone's
 * everyday login. Xero's History then attributes Claude's writes to an account
 * that is visibly Claude's, instead of mixing them into a person's own activity.
 *
 * The rule is a naming convention: a swiftotter.com address with "claude"
 * somewhere in the local part. It cannot tell how an account is used, only
 * what it is called.
 */
export function isClaudeAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return domain === "swiftotter.com" && local.includes("claude");
}

const XERO_USERINFO_URL = "https://identity.xero.com/connect/userinfo";

/** Resolves the connected Xero user's email; rejects if it cannot be read. */
export type XeroEmailLoader = () => Promise<string>;

/**
 * Ask Xero who this connection belongs to, using the access token the child
 * already holds. The email is read here, in the child, rather than carried in
 * the parent's JWT: those tokens live 30 days and are re-issued from their own
 * claims, so a claim added now would miss every user already connected — the
 * very case this gate exists for.
 */
const loadXeroEmail: XeroEmailLoader = async () => {
  await xeroClient.authenticate();
  const accessToken = xeroClient.readTokenSet()?.access_token;
  if (!accessToken) throw new Error("no Xero access token available");

  const response = await fetch(XERO_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // Status only: never echo a response body or the request back out.
  if (!response.ok) {
    throw new Error(`Xero userinfo returned ${response.status}`);
  }
  const userinfo = (await response.json()) as {
    email?: string;
    preferred_username?: string;
  };
  const email = userinfo.email ?? userinfo.preferred_username;
  if (!email) throw new Error("Xero userinfo returned no email");
  return email;
};

export interface ClaudeAccountGate {
  wrap(tool: ToolDefinition<ZodRawShapeCompat>): ToolDefinition<ZodRawShapeCompat>;
}

/**
 * Build the write gate. Exported (rather than inlined) so the gate itself is
 * testable against a stub loader — see scripts/verify-claude-account.mjs.
 *
 * When `enabled` is false the gate is a pass-through: a local client-credentials
 * or bearer-token connection has no Xero *user* behind it to check.
 */
export function createClaudeAccountGate(options: {
  enabled: boolean;
  loadEmail: XeroEmailLoader;
}): ClaudeAccountGate {
  // One child process per user (see child-pool.ts), and the child is keyed by
  // xero_userid, so a successful answer holds for the child's whole life.
  let email: string | null = null;
  let inFlight: Promise<string> | null = null;

  const resolveEmail = (): Promise<string> => {
    if (email !== null) return Promise.resolve(email);
    // Assigned synchronously, so concurrent writes share one lookup.
    if (inFlight) return inFlight;
    inFlight = options
      .loadEmail()
      .then((resolved) => {
        email = resolved;
        return resolved;
      })
      .finally(() => {
        // A failure is never cached: the next write retries the lookup.
        inFlight = null;
      });
    return inFlight;
  };

  const blocked = (toolName: string, logDetail: string, message: string[]) => {
    console.error(
      `[claude-account-gate] blocked ${toolName} for ${process.env.XERO_USER_NAME ?? "unknown user"}: ${logDetail}`,
    );
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: [`[WRITE BLOCKED — no data was written]`, ...message].join("\n"),
        },
      ],
    };
  };

  return {
    wrap(tool) {
      if (!options.enabled) return tool;

      const handler = (async (args: Record<string, unknown>, extra: unknown) => {
        let connectedEmail: string;
        try {
          connectedEmail = await resolveEmail();
        } catch (error) {
          // Fail closed: if we cannot tell who this is, do not write.
          const reason = ensureError(error).message;
          return blocked(tool.name, `identity lookup failed (${reason})`, [
            `Could not confirm which Xero user this connection is signed in as (${reason}), so writes are refused. Reads still work. Try again in a moment.`,
          ]);
        }

        if (!isClaudeAccountEmail(connectedEmail)) {
          return blocked(tool.name, `signed in as ${connectedEmail}`, [
            `This Xero connection is signed in as ${connectedEmail}, which is not a dedicated Claude account. Writes through this connector require a Xero login used only for Claude — a swiftotter.com address with "claude" in it, such as name+claude@swiftotter.com. Reads still work.`,
            ``,
            `To fix: sign out of Xero in your browser, then disconnect and reconnect the Xero connector in Claude and sign in with your Claude Xero account. Tell the user this; do not retry the write.`,
          ]);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tool.handler as any)(args, extra);
      }) as ToolDefinition<ZodRawShapeCompat>["handler"];

      return { ...tool, handler };
    },
  };
}

const claudeAccountGate = createClaudeAccountGate({
  // Only the hosted, per-user connection has a Xero user to check.
  enabled: xeroClient instanceof AuthorizationCodeXeroClient,
  loadEmail: loadXeroEmail,
});

/** Refuse a write tool's call unless the connected Xero user is a Claude account. */
export function requireClaudeAccount(
  tool: ToolDefinition<ZodRawShapeCompat>,
): ToolDefinition<ZodRawShapeCompat> {
  return claudeAccountGate.wrap(tool);
}
