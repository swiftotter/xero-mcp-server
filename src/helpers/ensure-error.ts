import { describeXeroApiError } from "./xero-api-error.js";

export function ensureError(value: unknown): Error {
  if (value instanceof Error) return value;

  // A xero-node rejection carries request headers; re-serializing it is how they leak.
  const xero = describeXeroApiError(value);
  if (xero) return new Error(xero);

  let stringified = "[Unable to stringify the thrown value]";
  try {
    stringified = JSON.stringify(value);
  } catch {
    /* empty */
  }

  const error = new Error(`Error thrown: ${stringified}`);
  return error;
}
