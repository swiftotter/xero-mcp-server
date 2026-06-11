import { ManualJournal } from "xero-node";
import { xeroClient } from "../clients/xero-client.js";
import { formatError } from "../helpers/format-error.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { toXeroDateTime } from "../helpers/to-xero-datetime.js";

const MAX_PAGE_SIZE = 100;

interface ListManualJournalsFilters {
  manualJournalId?: string;
  modifiedAfter?: string;
  fromDate?: string;
  toDate?: string;
  narration?: string;
  accountCode?: string;
  status?: "DRAFT" | "POSTED" | "VOIDED" | "DELETED" | "ARCHIVED";
  pageSize?: number;
}

async function getManualJournals(
  page: number,
  {
    manualJournalId,
    modifiedAfter,
    fromDate,
    toDate,
    narration,
    accountCode,
    status,
    pageSize,
  }: ListManualJournalsFilters,
): Promise<ManualJournal[]> {
  await xeroClient.authenticate();

  if (manualJournalId) {
    const response = await xeroClient.accountingApi.getManualJournal(
      xeroClient.tenantId,
      manualJournalId,
      getClientHeaders(),
    );

    return response.body.manualJournals ?? [];
  }

  // Date, narration and status filters are applied server-side via the Xero
  // `where` clause.
  const whereConditions: string[] = [];
  if (fromDate) {
    whereConditions.push(`Date >= ${toXeroDateTime(fromDate, "fromDate")}`);
  }
  if (toDate) {
    whereConditions.push(`Date <= ${toXeroDateTime(toDate, "toDate")}`);
  }
  if (narration) {
    const escaped = narration.toLowerCase().replace(/["\\]/g, "\\$&");
    whereConditions.push(
      `Narration != null AND Narration.ToLower().Contains("${escaped}")`,
    );
  }
  if (status) {
    whereConditions.push(`Status == "${status}"`);
  }
  const where =
    whereConditions.length > 0 ? whereConditions.join(" AND ") : undefined;

  // Searches read more naturally in journal-date order; otherwise keep the
  // original most-recently-updated ordering.
  const order = fromDate || toDate || narration ? "Date DESC" : "UpdatedDateUTC DESC";

  const resolvedPageSize = Math.min(pageSize ?? 10, MAX_PAGE_SIZE);

  const response = await xeroClient.accountingApi.getManualJournals(
    xeroClient.tenantId,
    modifiedAfter ? new Date(modifiedAfter) : undefined,
    where,
    order,
    page,
    resolvedPageSize,
    getClientHeaders(),
  );

  let results = response.body.manualJournals ?? [];

  // Xero cannot filter manual journals by line account server-side, so the
  // account-code filter is applied client-side to the fetched page only.
  if (accountCode) {
    results = results.filter((journal) =>
      journal.journalLines?.some((line) => line.accountCode === accountCode),
    );
  }

  return results;
}

/**
 * List all manual journals from Xero.
 */
export async function listXeroManualJournals(
  page: number = 1,
  filters: ListManualJournalsFilters = {},
): Promise<XeroClientResponse<ManualJournal[]>> {
  try {
    const manualJournals = await getManualJournals(page, filters);

    return {
      result: manualJournals,
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
