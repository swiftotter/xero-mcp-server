import { IXeroClientConfig, Organisation, XeroClient } from "xero-node";

import { ensureError } from "../../helpers/ensure-error.js";
import { shouldRetryAfterReauth } from "./token-recovery.js";

/**
 * The generated API objects the handlers actually call. Measured, not guessed: 64 uses of
 * `accountingApi` and 14 of `payrollNZApi` across `src/`. Anything added here must also be
 * added to the wrap list in the constructor.
 */
const RETRYING_APIS = ["accountingApi", "payrollNZApi"] as const;

export abstract class MCPXeroClient extends XeroClient {
  public tenantId: string;
  private shortCode: string;

  protected constructor(config?: IXeroClientConfig) {
    super(config);
    this.tenantId = "";
    this.shortCode = "";

    // Re-authenticate and retry once when Xero rejects the access token.
    //
    // WHY A WRAPPER RATHER THAN 60 EDITS. Every handler does `await
    // xeroClient.authenticate()` and then calls a generated `*Api` method directly, so
    // there is no funnel to put this in — and xero-node offers no seam of its own: the
    // token is assigned as a plain property onto each `*Api` object by `setAccessToken()`,
    // and the generated methods call the *global* axios default rather than a per-client
    // instance, so there is no interceptor to register that would not also affect every
    // other axios user in the process. Wrapping the two api objects is the one place that
    // covers all 78 call sites without touching any of them.
    for (const name of RETRYING_APIS) {
      const api = this[name] as unknown;
      if (api && typeof api === "object") {
        (this as unknown as Record<string, unknown>)[name] = this.withReauthRetry(
          api as Record<string, unknown>,
        );
      }
    }
  }

  public abstract authenticate(): Promise<void>;

  /**
   * Discard the cached access token so the next `authenticate()` mints a new one.
   *
   * Implementations must NOT discard the refresh token — for the authorization-code client
   * that would skip the `invalid_grant` recovery which re-reads Secret Manager, and turn a
   * self-healing race into a "re-run the bootstrap script" dead end.
   */
  public abstract invalidateAccessToken(): void;

  /**
   * Wrap every method of a generated API object so a 401 forces a fresh token and re-sends
   * the call exactly once.
   *
   * Retrying a request Xero answered with 401 cannot double-apply a write: authentication
   * happens before the request is processed, so an invoice or payment was never created.
   * That argument is why the predicate is 401-only and never 403 — see token-recovery.ts.
   */
  private withReauthRetry<T extends Record<string, unknown>>(api: T): T {
    // DO NOT ADD A `set` TRAP. `accessToken` on a generated api object is a WRITE-ONLY
    // setter on the prototype — `set accessToken(token) { this.authentications.OAuth2
    // .accessToken = token }`, with no getter, which is why reading it back gives
    // undefined. With only a `get` trap, `setAccessToken()`'s assignment reaches that
    // setter with `this` bound to the receiver and lands in the right place. A `set` trap
    // that wrote straight to the target would bypass the setter, and every refresh would
    // silently stop taking effect while all of this still looked correct.
    // `scripts/verify-auth-recovery.mjs` asserts the write survives.
    return new Proxy(api, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        // Non-methods pass through untouched.
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return async (...args: unknown[]): Promise<unknown> => {
          try {
            return await method.apply(target, args);
          } catch (error: unknown) {
            if (!shouldRetryAfterReauth(error, false)) throw error;

            const before = this.readTokenSet()?.access_token;
            this.invalidateAccessToken();
            await this.authenticate();
            const after = this.readTokenSet()?.access_token;

            // Only re-send if the credential actually changed. This is what makes the
            // bearer-token client behave as documented: its token comes from the
            // environment and is re-stamped verbatim, so there is nothing new to present
            // and a second attempt would just burn a round trip against Xero's auth
            // endpoint. The client-credentials client mints a fresh token on every
            // `authenticate()`, so it still retries.
            if (before === after) throw error;

            // `authenticate()` re-ran setAccessToken(), which reassigned the token on
            // `target`, so this call carries the new credential. It cannot recurse: the
            // retry sits outside the proxy's own catch.
            return await method.apply(target, args);
          }
        };
      },
    }) as T;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async updateTenants(fullOrgDetails?: boolean): Promise<any[]> {
    await super.updateTenants(fullOrgDetails);
    if (this.tenants && this.tenants.length > 0) {
      this.tenantId = this.tenants[0].tenantId;
    }
    return this.tenants;
  }

  private async getOrganisation(): Promise<Organisation> {
    await this.authenticate();

    const organisationResponse = await this.accountingApi.getOrganisations(
      this.tenantId || "",
    );

    const organisation = organisationResponse.body.organisations?.[0];

    if (!organisation) {
      throw new Error("Failed to retrieve organisation");
    }

    return organisation;
  }

  public async getShortCode(): Promise<string | undefined> {
    if (!this.shortCode) {
      try {
        const organisation = await this.getOrganisation();
        this.shortCode = organisation.shortCode ?? "";
      } catch (error: unknown) {
        const err = ensureError(error);

        throw new Error(
          `Failed to get Organisation short code: ${err.message}`,
        );
      }
    }
    return this.shortCode;
  }
}
