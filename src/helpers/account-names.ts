import { listXeroAccounts } from "../handlers/list-xero-accounts.handler.js";

/**
 * Account code -> account name, for rendering GL references as
 * "Accrued Payroll (2230)" instead of a bare "2230".
 *
 * Xero returns only `accountCode` on line items and journal lines — the name
 * lives on the separate chart-of-accounts resource — so every renderer that
 * shows a code has to join against this map or the caller sees a number with no
 * meaning attached.
 */
export type AccountNameMap = ReadonlyMap<string, string>;

const EMPTY: AccountNameMap = new Map<string, string>();

// The chart of accounts is small and changes rarely, but a single list-invoices
// call can render dozens of lines — so memoize per process. One long-lived child
// process per user (see child-pool.ts) means this cache is per-user and dies
// with the child; it is an in-process memo, not transport state.
const TTL_MS = 5 * 60 * 1000;

let cached: AccountNameMap | null = null;
let cachedAt = 0;
let inFlight: Promise<AccountNameMap> | null = null;

async function fetchAccountNameMap(): Promise<AccountNameMap> {
  const response = await listXeroAccounts();

  // Never throw: an account-name lookup must not be able to break a list or a
  // write preview. On failure callers degrade to showing the bare code.
  if (response.isError || !response.result) {
    return EMPTY;
  }

  const map = new Map<string, string>();
  for (const account of response.result) {
    if (account.code && account.name) {
      map.set(account.code, account.name);
    }
  }
  return map;
}

/**
 * Chart of accounts as code -> name. Cached for TTL_MS; concurrent callers share
 * one request. Resolves to an empty map rather than rejecting.
 */
export async function getAccountNameMap(): Promise<AccountNameMap> {
  if (cached && Date.now() - cachedAt < TTL_MS) {
    return cached;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchAccountNameMap()
    .catch(() => EMPTY)
    .then((map) => {
      // Don't cache a failed lookup — the next call should retry.
      if (map.size > 0) {
        cached = map;
        cachedAt = Date.now();
      }
      return map;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test seam: drop the memo so the next lookup refetches. */
export function resetAccountNameCache(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}

/**
 * Render a GL account reference as "Name (code)", falling back to the bare code
 * when the name is unknown (unmapped code, or a failed/empty lookup).
 */
export function formatAccountRef(
  code: string | undefined | null,
  accountNames: AccountNameMap,
): string {
  if (!code) {
    return "";
  }
  const name = accountNames.get(String(code));
  return name ? `${name} (${code})` : String(code);
}
