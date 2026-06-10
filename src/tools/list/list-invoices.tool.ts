import { z } from "zod";
import { listXeroInvoices } from "../../handlers/list-xero-invoices.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { formatLineItem } from "../../helpers/format-line-item.js";

const ListInvoicesTool = CreateXeroTool(
  "list-invoices",
  "List invoices in Xero. This includes Draft, Submitted, and Paid invoices. \
  Ask the user if they want to see invoices for a specific contact, \
  invoice number, date range, GL account, or to see all invoices before running. \
  Use fromDate/toDate (YYYY-MM-DD) to filter by invoice date; this is applied server-side. \
  Use accountCode to filter to invoices with a line item posting to a GL account code; \
  this is applied client-side to the current page only, so raise pageSize and page through to scan thoroughly. \
  pageSize defaults to 10 and is capped at 100; raise it when scanning many invoices in one call. \
  Pass lineItems=true (or filter by invoiceNumbers) to include per-line detail and tracking. \
  If a full page is returned, more may exist — call again with page+1.",
  {
    page: z.number(),
    contactIds: z.array(z.string()).optional(),
    invoiceNumbers: z
      .array(z.string())
      .optional()
      .describe("If provided, invoice line items will also be returned"),
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe(
        "Only invoices dated on/after this date (invoice Date, inclusive).",
      ),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe(
        "Only invoices dated on/before this date (invoice Date, inclusive).",
      ),
    accountCode: z
      .string()
      .optional()
      .describe(
        'Filter to invoices with a line item posting to this GL account code (e.g. "200"). Applied client-side to the current page only, so raise pageSize and page through to scan thoroughly.',
      ),
    lineItems: z
      .boolean()
      .optional()
      .describe(
        "If true, include line items (with tracking) for every invoice in the page. Defaults to false unless invoiceNumbers is provided.",
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Optional page size (1–100). Defaults to 10."),
  },
  async ({
    page,
    contactIds,
    invoiceNumbers,
    fromDate,
    toDate,
    accountCode,
    lineItems,
    pageSize,
  }) => {
    // The account-code filter runs client-side over the fetched page, so when
    // it's active scan the largest page possible (unless the caller set one).
    const resolvedPageSize =
      pageSize ?? (accountCode ? 100 : undefined);
    const response = await listXeroInvoices(page, {
      contactIds,
      invoiceNumbers,
      fromDate,
      toDate,
      accountCode,
      pageSize: resolvedPageSize,
    });
    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing invoices: ${response.error}`,
          },
        ],
      };
    }

    const invoices = response.result;
    const returnLineItems =
      lineItems === true ||
      (invoiceNumbers?.length ?? 0) > 0 ||
      accountCode !== undefined;

    return {
      content: [
        {
          type: "text" as const,
          text: accountCode
            ? `Found ${invoices?.length || 0} invoice(s) on this page with a line item on account ${accountCode} (filtered client-side — page through for more):`
            : `Found ${invoices?.length || 0} invoices:`,
        },
        ...(invoices?.map((invoice) => ({
          type: "text" as const,
          text: [
            `Invoice ID: ${invoice.invoiceID}`,
            `Invoice: ${invoice.invoiceNumber}`,
            invoice.reference ? `Reference: ${invoice.reference}` : null,
            `Type: ${invoice.type || "Unknown"}`,
            `Status: ${invoice.status || "Unknown"}`,
            invoice.contact
              ? `Contact: ${invoice.contact.name} (${invoice.contact.contactID})`
              : null,
            invoice.date ? `Date: ${invoice.date}` : null,
            invoice.dueDate ? `Due Date: ${invoice.dueDate}` : null,
            invoice.lineAmountTypes
              ? `Line Amount Types: ${invoice.lineAmountTypes}`
              : null,
            invoice.subTotal ? `Sub Total: ${invoice.subTotal}` : null,
            invoice.totalTax ? `Total Tax: ${invoice.totalTax}` : null,
            `Total: ${invoice.total || 0}`,
            invoice.totalDiscount
              ? `Total Discount: ${invoice.totalDiscount}`
              : null,
            invoice.currencyCode ? `Currency: ${invoice.currencyCode}` : null,
            invoice.currencyRate
              ? `Currency Rate: ${invoice.currencyRate}`
              : null,
            invoice.updatedDateUTC
              ? `Last Updated: ${invoice.updatedDateUTC}`
              : null,
            invoice.fullyPaidOnDate
              ? `Fully Paid On: ${invoice.fullyPaidOnDate}`
              : null,
            invoice.amountDue ? `Amount Due: ${invoice.amountDue}` : null,
            invoice.amountPaid ? `Amount Paid: ${invoice.amountPaid}` : null,
            invoice.amountCredited
              ? `Amount Credited: ${invoice.amountCredited}`
              : null,
            invoice.hasErrors ? "Has Errors: Yes" : null,
            invoice.isDiscounted ? "Is Discounted: Yes" : null,
            returnLineItems
              ? `Line Items:\n${invoice.lineItems?.map(formatLineItem).join("\n\n")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListInvoicesTool;
