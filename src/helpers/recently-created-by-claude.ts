/**
 * Check whether a Xero resource was created by the current MCP user via
 * Claude within the last hour, using the audit History note posted by
 * postAuditNote() at creation time.
 *
 * This is the basis for relaxing the draft-only guard on updates: a
 * non-draft invoice/credit note may still be edited shortly after Claude
 * created it, so mistakes can be fixed without leaving the MCP.
 *
 * History notes are free text and can be posted by any org user, so the
 * note alone is not trusted as proof of recency: the 1-hour window is
 * anchored to the EARLIEST history entry on the record — its actual
 * creation point, which cannot be back-dated by posting new notes. The
 * matching audit note then establishes who created it. Display names are
 * not unique, so this remains a change-control guard for a small internal
 * team, not a hard security boundary.
 *
 * Fails closed — any error (or a missing/stale/other-user note, or a
 * session with no authenticated user name) means the edit stays blocked.
 */
import { xeroClient } from "../clients/xero-client.js";
import {
  auditNoteDetails,
  hasAuthenticatedUserName,
} from "./post-audit-note.js";

const EDIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function wasRecentlyCreatedByCurrentUser(
  resourceType: "Invoice" | "CreditNote",
  resourceId: string,
): Promise<boolean> {
  try {
    // No authenticated identity → no "current user" to match. Without this,
    // every session falling back to "Unknown user" would match every other.
    if (!hasAuthenticatedUserName()) return false;

    await xeroClient.authenticate();
    const api = xeroClient.accountingApi;
    const tenantId = xeroClient.tenantId;

    const response =
      resourceType === "Invoice"
        ? await api.getInvoiceHistory(tenantId, resourceId)
        : await api.getCreditNoteHistory(tenantId, resourceId);

    const timestamps = (response.body.historyRecords ?? [])
      .map((record) => (record.dateUTC ? new Date(record.dateUTC).getTime() : NaN))
      .filter((time) => !Number.isNaN(time));
    if (timestamps.length === 0) return false;

    const createdAt = Math.min(...timestamps);
    if (Date.now() - createdAt > EDIT_WINDOW_MS) return false;

    const expectedDetails = auditNoteDetails("Created");
    return (response.body.historyRecords ?? []).some(
      (record) => record.details === expectedDetails,
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(
      `[audit] failed to check creation history on ${resourceType} ${resourceId}: ${msg}`,
    );
    return false;
  }
}
