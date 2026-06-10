import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Invoice } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { toXeroDateTime } from "../helpers/to-xero-datetime.js";

const MAX_PAGE_SIZE = 100;

interface ListInvoicesFilters {
  contactIds?: string[];
  invoiceNumbers?: string[];
  pageSize?: number;
  fromDate?: string;
  toDate?: string;
  accountCode?: string;
}

async function getInvoices(
  page: number,
  {
    contactIds,
    invoiceNumbers,
    pageSize,
    fromDate,
    toDate,
    accountCode,
  }: ListInvoicesFilters,
): Promise<Invoice[]> {
  await xeroClient.authenticate();

  // Date filters are applied server-side via the Xero `where` clause.
  const whereConditions: string[] = [];
  if (fromDate) {
    whereConditions.push(`Date >= ${toXeroDateTime(fromDate, "fromDate")}`);
  }
  if (toDate) {
    whereConditions.push(`Date <= ${toXeroDateTime(toDate, "toDate")}`);
  }
  const where =
    whereConditions.length > 0 ? whereConditions.join(" AND ") : undefined;

  const resolvedPageSize = Math.min(pageSize ?? 10, MAX_PAGE_SIZE);

  const invoices = await xeroClient.accountingApi.getInvoices(
    xeroClient.tenantId,
    undefined, // ifModifiedSince
    where, // where
    "UpdatedDateUTC DESC", // order
    undefined, // iDs
    invoiceNumbers, // invoiceNumbers
    contactIds, // contactIDs
    undefined, // statuses
    page,
    false, // includeArchived
    false, // createdByMyApp
    undefined, // unitdp
    false, // summaryOnly
    resolvedPageSize, // pageSize
    undefined, // searchTerm
    getClientHeaders(),
  );

  let results = invoices.body.invoices ?? [];

  // Xero cannot filter invoices by line-item account server-side, so the
  // account-code filter is applied client-side to the fetched page only.
  if (accountCode) {
    results = results.filter((invoice) =>
      invoice.lineItems?.some((line) => line.accountCode === accountCode),
    );
  }

  return results;
}

/**
 * List all invoices from Xero
 */
export async function listXeroInvoices(
  page: number = 1,
  filters: ListInvoicesFilters = {},
): Promise<XeroClientResponse<Invoice[]>> {
  try {
    const invoices = await getInvoices(page, filters);

    return {
      result: invoices,
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
