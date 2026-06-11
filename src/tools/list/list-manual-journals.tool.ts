import { ManualJournal } from "xero-node";
import { listXeroManualJournals } from "../../handlers/list-xero-manual-journals.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { z } from "zod";

const ListManualJournalsTool = CreateXeroTool(
  "list-manual-journals",
  `List manual journals (journal entries) from Xero.
Can pass a manual journal ID to retrieve a specific journal; all other filters are ignored when an ID is given.
Use fromDate/toDate (YYYY-MM-DD) to filter by journal date, narration to search journal descriptions (case-insensitive substring), and status to limit by journal status (e.g. POSTED); these are all applied server-side across every journal.
Use accountCode to filter to journals with a line posting to a GL account code; this is applied client-side to the current page only, so raise pageSize and page through to scan thoroughly.
pageSize defaults to 10 and is capped at 100; raise it when scanning many journals in one call.
When date or narration filters are set, results are ordered by journal date (newest first); otherwise by last updated.
If a full page is returned, more may exist — call again with page+1.`,
  {
    manualJournalId: z
      .string()
      .optional()
      .describe("Optional ID of the manual journal to retrieve"),
    modifiedAfter: z
      .string()
      .optional()
      .describe(
        "Optional date YYYY-MM-DD to filter journals modified after this date",
      ),
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe(
        "Only journals dated on/after this date (journal Date, inclusive).",
      ),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .optional()
      .describe(
        "Only journals dated on/before this date (journal Date, inclusive).",
      ),
    narration: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring search on the journal narration (description), e.g. "accrual". Applied server-side across all journals.',
      ),
    accountCode: z
      .string()
      .optional()
      .describe(
        'Filter to journals with a line posting to this GL account code (e.g. "2150"). Applied client-side to the current page only, so raise pageSize and page through to scan thoroughly.',
      ),
    status: z
      .enum(["DRAFT", "POSTED", "VOIDED", "DELETED", "ARCHIVED"])
      .optional()
      .describe("Filter by journal status."),
    page: z.number().optional().describe("Optional page number for pagination"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Optional page size (1–100). Defaults to 10."),
  },
  async (args) => {
    // The account-code filter runs client-side over the fetched page, so when
    // it's active scan the largest page possible (unless the caller set one).
    const resolvedPageSize =
      args?.pageSize ?? (args?.accountCode ? 100 : undefined);
    const response = await listXeroManualJournals(args?.page, {
      manualJournalId: args?.manualJournalId,
      modifiedAfter: args?.modifiedAfter,
      fromDate: args?.fromDate,
      toDate: args?.toDate,
      narration: args?.narration,
      accountCode: args?.accountCode,
      status: args?.status,
      pageSize: resolvedPageSize,
    });

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing manual journals: ${response.error}`,
          },
        ],
      };
    }

    const manualJournals = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: args?.accountCode
            ? `Found ${manualJournals?.length || 0} manual journal(s) on this page with a line on account ${args.accountCode} (filtered client-side — page through for more):`
            : `Found ${manualJournals?.length || 0} manual journals:`,
        },
        ...(manualJournals?.map((journal: ManualJournal) => ({
          type: "text" as const,
          text: [
            `Manual Journal ID: ${journal.manualJournalID}`,
            journal.narration
              ? `Description: ${journal.narration}`
              : "No description",
            journal.date ? `Date: ${journal.date}` : null,
            journal.journalLines
              ? journal.journalLines.map((line) =>
                  [
                    `Line Amount: ${line.lineAmount}`,
                    line.accountCode
                      ? `Account Code: ${line.accountCode}`
                      : "No account code",
                    line.description
                      ? `Description: ${line.description}`
                      : "No description",
                    line.taxType ? `Tax Type: ${line.taxType}` : "No tax type",
                    `Tax Amount: ${line.taxAmount}`,
                    line.tracking && line.tracking.length > 0
                      ? `Tracking: ${JSON.stringify(line.tracking)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("\n")
                ).join("\n\n")
              : "No journal lines",
            journal.lineAmountTypes
              ? `Line Amount Types: ${journal.lineAmountTypes}`
              : "No line amount types",
            journal.status ? `Status: ${journal.status}` : "No status",
            journal.url ? `URL: ${journal.url}` : "No URL",
            `Show on Cash Basis Reports: ${journal.showOnCashBasisReports}`,
            `Has Attachments: ${journal.hasAttachments}`,
            journal.updatedDateUTC
              ? `Last Updated: ${journal.updatedDateUTC.toLocaleDateString()}`
              : "No last updated date",
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListManualJournalsTool;
