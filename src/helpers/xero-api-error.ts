/**
 * Turns a rejected xero-node call into a status and a human message — and nothing else.
 *
 * WHY THIS EXISTS. Every generated method (`accountingApi.*`, `payrollNZApi.*`) rejects with
 * `JSON.stringify(new ApiError(axiosError).generateError())`: a *string*, not an Error, holding
 * the response body, the response headers, and the request's URL, method and headers. Through
 * xero-node 19.3.0 (13.4.0 on our line) those request headers were copied verbatim, so the
 * blob carried `Authorization: Bearer <access token>`, and the token-endpoint paths rejected
 * the raw axios error, whose `config` carries the Basic client-secret header and the
 * refresh-token body. Xero's security notice of September 2026 covers it; 13.5.0 redacts.
 *
 * The upgrade is the fix. This is the second wall: anything that renders a thrown value —
 * `formatError()` for tool results (which go to the assistant), `ensureError()`, and the audit
 * log lines — goes through here, so it emits the status plus the fields Xero writes for
 * people to read, and never re-serializes the error. `npm run verify:deps` asserts both the
 * installed ApiError and this helper keep credentials out.
 */

export type XeroApiErrorSummary = {
  status?: number;
  message?: string;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First string value among `keys`, trying each key as given and camelCased — the
 * deserialized body (non-2xx resolve path) is camelCase, the raw one (catch path) PascalCase. */
function pick(obj: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    for (const k of [key, key.charAt(0).toLowerCase() + key.slice(1)]) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function list(obj: Json, key: string): Json[] {
  const v = obj[key] ?? obj[key.charAt(0).toLowerCase() + key.slice(1)];
  return Array.isArray(v) ? v.filter(isObject) : [];
}

/** The messages Xero writes for people, across the accounting, payroll and OAuth shapes. */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim() || undefined;
  if (!isObject(body)) return undefined;

  // Accounting validation: { Elements: [{ ValidationErrors: [{ Message }] }] }
  const validation = list(body, "Elements")
    .flatMap((el) => list(el, "ValidationErrors"))
    .map((v) => pick(v, "Message"))
    .filter((m): m is string => Boolean(m));
  if (validation.length > 0) return [...new Set(validation)].join("; ");

  // Payroll NZ: { problem: { title, detail, invalidFields: [{ name, reason }] } }
  const problem = isObject(body.problem) ? body.problem : undefined;
  if (problem) {
    const fields = list(problem, "InvalidFields")
      .map((f) => [pick(f, "Name"), pick(f, "Reason")].filter(Boolean).join(": "))
      .filter(Boolean);
    const head = pick(problem, "Detail", "Title");
    const parts = [head, ...fields].filter(Boolean);
    if (parts.length > 0) return parts.join("; ");
  }

  // OAuth token endpoint: { error, error_description }
  const oauth = pick(body, "error_description", "error");
  return pick(body, "Detail", "Message", "Title") ?? oauth;
}

/**
 * Recognise the shapes xero-node rejects with: the JSON string from a generated method, or the
 * `{ response, body }` object from a non-2xx resolve and from `XeroClient`'s token requests.
 * Returns null for anything else, so callers keep their existing handling.
 */
export function parseXeroApiError(value: unknown): XeroApiErrorSummary | null {
  let obj: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!isObject(obj) || obj instanceof Error) return null;
  if (!("response" in obj) && !("body" in obj)) return null;

  const response = isObject(obj.response) ? obj.response : {};
  const statusRaw = response.statusCode ?? response.status;
  const status = typeof statusRaw === "number" && statusRaw > 0 ? statusRaw : undefined;
  const message = messageFromBody(obj.body ?? response.body ?? response.data);

  if (status === undefined && message === undefined) return null;
  return { status, message };
}

/** One line for a xero-node rejection, or null if `value` is not one. */
export function describeXeroApiError(value: unknown): string | null {
  const parsed = parseXeroApiError(value);
  if (!parsed) return null;
  const { status, message } = parsed;
  if (status === undefined) return `Xero returned an error: ${message}`;
  return message ? `Xero returned ${status}: ${message}` : `Xero returned ${status}.`;
}
