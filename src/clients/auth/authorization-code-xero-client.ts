import { AxiosError } from "axios";

import { ensureError } from "../../helpers/ensure-error.js";
import { MCPXeroClient } from "./mcp-xero-client.js";
import {
  destroySupersededVersions,
  newestEnabledVersion,
} from "./token-recovery.js";

const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60;

function detailOf(error: unknown): string {
  const err = ensureError(error);
  const responseData = (error as AxiosError).response?.data;
  return typeof responseData === "string"
    ? responseData
    : responseData
      ? JSON.stringify(responseData)
      : err.message;
}

function isInvalidGrant(error: unknown): boolean {
  return (
    (error as AxiosError).response?.status === 400 ||
    /invalid_grant/.test(detailOf(error))
  );
}

type SecretManagerClient = {
  accessSecretVersion: (req: { name: string }) => Promise<
    [{ payload?: { data?: Buffer | Uint8Array | string | null } }]
  >;
  addSecretVersion: (req: {
    parent: string;
    payload: { data: Buffer };
  }) => Promise<[{ name?: string | null }]>;
  listSecretVersions: (req: { parent: string; filter?: string }) => Promise<
    [Array<{ name?: string | null; state?: string | number | null }>]
  >;
  destroySecretVersion: (req: { name: string }) => Promise<unknown>;
};

export class AuthorizationCodeXeroClient extends MCPXeroClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly secretName: string;
  private secretClient: SecretManagerClient | null = null;
  private currentRefreshToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private latestVersionName: string | null = null;
  private authInFlight: Promise<void> | null = null;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    secretName: string;
  }) {
    super({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      grantType: "authorization_code",
    });
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.secretName = config.secretName;
  }

  /**
   * Whether we hold an access token that is actually present and not about to expire.
   *
   * The predicate this replaced was `this.tenantId && this.accessTokenExpiresAt > ...`.
   * `tenantId` means *which Xero org*, not *do I have a credential* — this class has no
   * access-token field of its own, because the token lives in xero-node's private
   * `_tokenSet`. So a known tenant plus a future timestamp skipped the refresh even with no
   * usable token behind it. Reading the token set is what makes the gate mean what it says.
   *
   * `tenantId` is still required, because `refreshAndUpdate()` is also what populates it.
   */
  private hasUsableAccessToken(): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!this.tenantId) return false;
    if (this.accessTokenExpiresAt <= nowSec + ACCESS_TOKEN_REFRESH_BUFFER_SECONDS) {
      return false;
    }
    return Boolean(this.readTokenSet()?.access_token);
  }

  /**
   * Force the next `authenticate()` to mint a new access token.
   *
   * Called by the reauth-retry wrapper in MCPXeroClient when Xero answers 401. Zeroing the
   * expiry is enough — and is all that should happen. In particular `currentRefreshToken` is
   * left alone: clearing it would make `usedCachedToken` false on the next attempt, which
   * disables the `invalid_grant` retry below and converts a recoverable rotation race into a
   * "re-run the bootstrap script" dead end.
   */
  public invalidateAccessToken(): void {
    this.accessTokenExpiresAt = 0;
  }

  public async authenticate(): Promise<void> {
    if (this.hasUsableAccessToken()) {
      return;
    }

    // Serialize refresh: this user's child can receive concurrent relayed tool
    // calls (Claude issues parallel tool_use). Xero rotates the refresh token on
    // every refresh and the old one dies, so two callers refreshing at once would
    // race the rotation and one would get invalid_grant. Share a single in-flight
    // refresh instead.
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.refreshAndUpdate().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async refreshAndUpdate(): Promise<void> {
    // Re-check inside the critical section: a refresh we queued behind may have
    // just populated a valid token.
    if (this.hasUsableAccessToken()) {
      return;
    }

    if (!this.currentRefreshToken) {
      this.currentRefreshToken = await this.readLatestRefreshToken();
    }

    let tokenSet;
    try {
      tokenSet = await this.refreshWithRefreshToken(
        this.clientId,
        this.clientSecret,
        this.currentRefreshToken,
      );
    } catch (error) {
      if (!isInvalidGrant(error)) {
        throw new Error(
          `Failed to refresh Xero access token: ${detailOf(error)}`,
        );
      }
      // invalid_grant: our cached token may be stale because a concurrent child
      // (e.g. one draining during a rolling deploy) rotated it in Secret Manager
      // after we last read it. Re-read versions/latest ONCE and retry before the
      // hard re-bootstrap error — single-use rotation makes this a real window.
      const latest = await this.readLatestRefreshToken();
      if (latest === this.currentRefreshToken) {
        throw new Error(
          `Xero refused the stored refresh token. Re-run the bootstrap script (bin/xero-oauth-bootstrap.ts) for this user. Underlying: ${detailOf(error)}`,
        );
      }
      this.currentRefreshToken = latest;
      try {
        tokenSet = await this.refreshWithRefreshToken(
          this.clientId,
          this.clientSecret,
          this.currentRefreshToken,
        );
      } catch (retryError) {
        throw new Error(
          `Xero refused the stored refresh token even after reloading the latest secret version. Re-run the bootstrap script (bin/xero-oauth-bootstrap.ts) for this user. Underlying: ${detailOf(retryError)}`,
        );
      }
    }

    if (
      tokenSet.refresh_token &&
      tokenSet.refresh_token !== this.currentRefreshToken
    ) {
      await this.persistRefreshToken(tokenSet.refresh_token);
      this.currentRefreshToken = tokenSet.refresh_token;
    }

    // Read the clock HERE. It used to come from a `nowSec` captured before the Secret
    // Manager read and the Xero token round trip, so the fallback expiry was short by
    // however long those took — harmless against a 60s buffer, but wrong for no reason.
    this.accessTokenExpiresAt =
      tokenSet.expires_at ??
      Math.floor(Date.now() / 1000) + (tokenSet.expires_in ?? 1800);

    if (!this.tenantId) {
      await this.updateTenants(false);
    }
  }

  private async getSecretClient(): Promise<SecretManagerClient> {
    if (!this.secretClient) {
      const mod = await import("@google-cloud/secret-manager");
      const ClientCtor = mod.SecretManagerServiceClient;
      this.secretClient = new ClientCtor() as unknown as SecretManagerClient;
    }
    return this.secretClient;
  }

  private async readLatestRefreshToken(): Promise<string> {
    const client = await this.getSecretClient();

    // The newest ENABLED version, explicitly — not the `latest` alias, which resolves
    // regardless of state and makes accessSecretVersion throw FAILED_PRECONDITION on a
    // disabled version instead of falling back. See token-recovery.ts.
    const [versions] = await client.listSecretVersions({
      parent: this.secretName,
      filter: "state:ENABLED",
    });
    const newest = newestEnabledVersion(versions);
    if (!newest) {
      throw new Error(
        `Secret ${this.secretName} has no enabled version. Re-run the bootstrap script ` +
          `(bin/xero-oauth-bootstrap.ts) for this user.`,
      );
    }

    const [version] = await client.accessSecretVersion({ name: newest });
    const data = version.payload?.data;
    if (!data) {
      throw new Error(
        `Secret ${this.secretName} has no payload. Run the bootstrap script for this user.`,
      );
    }
    const token =
      typeof data === "string"
        ? data
        : Buffer.from(data as Uint8Array).toString("utf8");
    return token.trim();
  }

  private async persistRefreshToken(newToken: string): Promise<void> {
    const client = await this.getSecretClient();
    const [created] = await client.addSecretVersion({
      parent: this.secretName,
      payload: { data: Buffer.from(newToken, "utf8") },
    });
    this.latestVersionName = created.name ?? null;

    // Pass the version we just wrote rather than letting the cleanup re-read the field.
    // The read would otherwise happen after `await getSecretClient()`, so its safety would
    // rest on an argument about serialized refreshes and monotonic version numbers rather
    // than on anything local — and here a wrong answer destroys the only copy of a live
    // single-use credential, irreversibly.
    void this.destroyOldVersions(created.name ?? null).catch((e) => {
      // Best effort, but NOT cosmetic: Xero's rotation is single-use, so the stored secret
      // is the only copy of a live credential. Destroying the wrong version locks the user
      // out entirely, and unlike disabling it cannot be undone. See versionsToDestroy().
      // Logged, not swallowed: this only catches what escapes the per-version loop —
      // above all a listSecretVersions failure, which is the one that silently stops
      // ALL cleanup rather than one version's. That matters because the call now
      // carries a `filter`; if the grammar were ever rejected, an empty handler here
      // would hide it and the billing backlog would quietly return.
      console.error("[oauth] destroyOldVersions: cleanup failed", e);
    });
  }

  private async destroyOldVersions(justWritten: string | null): Promise<void> {
    const client = await this.getSecretClient();
    await destroySupersededVersions(client, this.secretName, justWritten);
  }
}
