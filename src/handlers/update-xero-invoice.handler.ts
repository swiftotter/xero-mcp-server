import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Invoice, LineItemTracking } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { postAuditNote } from "../helpers/post-audit-note.js";
import { wasRecentlyCreatedByCurrentUser } from "../helpers/recently-created-by-claude.js";
import {
  applyInvoiceExtras,
  InvoiceExtras,
} from "./create-xero-invoice.handler.js";

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  itemCode?: string;
  tracking?: LineItemTracking[];
}

async function getInvoice(invoiceId: string): Promise<Invoice | undefined> {
  await xeroClient.authenticate();

  // First, get the current invoice to check its status
  const response = await xeroClient.accountingApi.getInvoice(
    xeroClient.tenantId,
    invoiceId, // invoiceId
    undefined, // unitdp
    getClientHeaders(), // options
  );

  return response.body.invoices?.[0];
}

async function updateInvoice(
  invoiceId: string,
  lineItems?: InvoiceLineItem[],
  reference?: string,
  dueDate?: string,
  date?: string,
  contactId?: string,
  extras?: InvoiceExtras,
): Promise<Invoice | undefined> {
  const invoice: Invoice = {
    lineItems: lineItems,
    reference: reference,
    dueDate: dueDate,
    date: date,
    contact: contactId ? { contactID: contactId } : undefined,
  };

  if (extras) applyInvoiceExtras(invoice, extras);

  const response = await xeroClient.accountingApi.updateInvoice(
    xeroClient.tenantId,
    invoiceId, // invoiceId
    {
      invoices: [invoice],
    }, // invoices
    undefined, // unitdp
    undefined, // idempotencyKey
    getClientHeaders(), // options
  );

  return response.body.invoices?.[0];
}

/**
 * Update an existing invoice in Xero
 */
export async function updateXeroInvoice(
  invoiceId: string,
  lineItems?: InvoiceLineItem[],
  reference?: string,
  dueDate?: string,
  date?: string,
  contactId?: string,
  extras?: InvoiceExtras,
): Promise<XeroClientResponse<Invoice>> {
  try {
    const existingInvoice = await getInvoice(invoiceId);

    if (!existingInvoice) {
      return {
        result: null,
        isError: true,
        error: `Invoice not found: ${invoiceId}`,
      };
    }

    const invoiceStatus = existingInvoice.status;

    // Only allow updates to DRAFT invoices, unless the current user created
    // this invoice via Claude within the last hour (grace window for fixing
    // mistakes on freshly created non-draft invoices).
    if (invoiceStatus !== Invoice.StatusEnum.DRAFT) {
      const recentlyCreated = await wasRecentlyCreatedByCurrentUser(
        "Invoice",
        invoiceId,
      );
      if (!recentlyCreated) {
        return {
          result: null,
          isError: true,
          error: `Cannot update invoice because it is not a draft (status: ${invoiceStatus}). Non-draft invoices can only be edited within 1 hour of being created by you via Claude.`,
        };
      }
    }

    const updatedInvoice = await updateInvoice(
      invoiceId,
      lineItems,
      reference,
      dueDate,
      date,
      contactId,
      extras,
    );

    if (!updatedInvoice) {
      throw new Error("Invoice update failed.");
    }

    await postAuditNote("Invoice", updatedInvoice.invoiceID, "Updated");

    return {
      result: updatedInvoice,
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
