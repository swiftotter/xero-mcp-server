import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { CreditNote, LineItemTracking } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { postAuditNote } from "../helpers/post-audit-note.js";
import { wasRecentlyCreatedByCurrentUser } from "../helpers/recently-created-by-claude.js";
import {
  applyCreditNoteCurrency,
  CreditNoteUpdateExtras,
} from "./create-xero-credit-note.handler.js";

interface CreditNoteLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  tracking?: LineItemTracking[];
}

async function getCreditNote(creditNoteId: string): Promise<CreditNote | null> {
  await xeroClient.authenticate();

  // First, get the current credit note to check its status
  const response = await xeroClient.accountingApi.getCreditNote(
    xeroClient.tenantId,
    creditNoteId, // creditNoteId
    undefined, // unitdp
    getClientHeaders(), // options
  );

  return response.body.creditNotes?.[0] ?? null;
}

async function updateCreditNote(
  creditNoteId: string,
  lineItems?: CreditNoteLineItem[],
  reference?: string,
  contactId?: string,
  date?: string,
  extras?: CreditNoteUpdateExtras,
): Promise<CreditNote | null> {
  const creditNote: CreditNote = {
    lineItems: lineItems,
    reference: reference,
    date: date,
    contact: contactId ? { contactID: contactId } : undefined,
  };

  if (extras?.dueDate !== undefined) creditNote.dueDate = extras.dueDate;
  if (extras?.brandingThemeID !== undefined) creditNote.brandingThemeID = extras.brandingThemeID;
  applyCreditNoteCurrency(creditNote, extras?.currencyCode, extras?.currencyRate);

  const response = await xeroClient.accountingApi.updateCreditNote(
    xeroClient.tenantId,
    creditNoteId, // creditNoteId
    {
      creditNotes: [creditNote],
    }, // creditNotes
    undefined, // unitdp
    undefined, // idempotencyKey
    getClientHeaders(), // options
  );

  return response.body.creditNotes?.[0] ?? null;
}

/**
 * Update an existing credit note in Xero
 */
export async function updateXeroCreditNote(
  creditNoteId: string,
  lineItems?: CreditNoteLineItem[],
  reference?: string,
  contactId?: string,
  date?: string,
  extras?: CreditNoteUpdateExtras,
): Promise<XeroClientResponse<CreditNote>> {
  try {
    const existingCreditNote = await getCreditNote(creditNoteId);

    if (!existingCreditNote) {
      return {
        result: null,
        isError: true,
        error: `Credit note not found: ${creditNoteId}`,
      };
    }

    const creditNoteStatus = existingCreditNote.status;

    // Only allow updates to DRAFT credit notes, unless the current user
    // created this credit note via Claude within the last hour (grace window
    // for fixing mistakes on freshly created non-draft credit notes).
    if (creditNoteStatus !== CreditNote.StatusEnum.DRAFT) {
      const recentlyCreated = await wasRecentlyCreatedByCurrentUser(
        "CreditNote",
        creditNoteId,
      );
      if (!recentlyCreated) {
        return {
          result: null,
          isError: true,
          error: `Cannot update credit note because it is not a draft (status: ${creditNoteStatus}). Non-draft credit notes can only be edited within 1 hour of being created by you via Claude.`,
        };
      }
    }

    const updatedCreditNote = await updateCreditNote(
      creditNoteId,
      lineItems,
      reference,
      contactId,
      date,
      extras,
    );

    if (!updatedCreditNote) {
      throw new Error("Credit note update failed.");
    }

    await postAuditNote("CreditNote", updatedCreditNote.creditNoteID, "Updated");


    return {
      result: updatedCreditNote,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
} 