import { AxiosError } from "axios";

import { describeXeroApiError, parseXeroApiError } from "./xero-api-error.js";

function messageForStatus(
  status: number | undefined,
  detail: string | undefined,
): string {
  switch (status) {
    case 401:
      return "Authentication failed. Please check your Xero credentials.";
    case 403:
      return "You don't have permission to access this resource in Xero.";
    case 404:
      return "The requested resource was not found in Xero.";
    case 429:
      return "Too many requests to Xero. Please try again in a moment.";
    default:
      return detail || "An error occurred while communicating with Xero.";
  }
}

/**
 * Format error messages in a user-friendly way
 */
export function formatError(error: unknown): string {
  if (error instanceof AxiosError) {
    return messageForStatus(
      error.response?.status,
      error.response?.data?.Detail,
    );
  }
  // xero-node's generated methods reject with a JSON string that includes the request
  // headers. Never interpolate it: take the status and Xero's own message out of it.
  // See src/helpers/xero-api-error.ts.
  const xero = parseXeroApiError(error);
  if (xero) {
    return messageForStatus(xero.status, describeXeroApiError(error) ?? undefined);
  }
  return error instanceof Error
    ? error.message
    : `An unexpected error occurred: ${error}`;
}
