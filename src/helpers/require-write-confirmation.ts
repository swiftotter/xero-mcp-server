import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import { AccountNameMap, getAccountNameMap } from "./account-names.js";

export type WriteAction = "create" | "update" | "delete" | "approve" | "revert";

/**
 * Collect every `accountCode` value anywhere in the argument tree — journal
 * lines and invoice line items are both arrays of objects, and some tools nest
 * them a level deeper (e.g. an item's salesDetails).
 */
export function collectAccountCodes(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectAccountCodes(entry, found);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "accountCode" &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      found.add(String(entry));
    } else {
      collectAccountCodes(entry, found);
    }
  }
}

/**
 * The preview below is shown to the user verbatim, and the raw parameters carry
 * bare GL codes ("accountCode": "2230") with no indication of what they are. Add
 * a legend naming each one so the approval decision is made on names, not
 * numbers. Returns null when there is nothing to name — no codes present, or the
 * chart-of-accounts lookup came back empty — so the preview never regresses.
 */
export function buildAccountLegend(
  codes: ReadonlySet<string>,
  accountNames: AccountNameMap,
): string | null {
  if (codes.size === 0) return null;

  const named = [...codes]
    .map((code) => {
      const name = accountNames.get(code);
      return name ? `${code} = ${name}` : null;
    })
    .filter((entry): entry is string => entry !== null);

  return named.length > 0 ? `Accounts referenced: ${named.join(", ")}` : null;
}

async function accountLegend(args: unknown): Promise<string | null> {
  // Walk once, and skip the lookup entirely when there is nothing to name.
  const codes = new Set<string>();
  collectAccountCodes(args, codes);
  if (codes.size === 0) return null;

  return buildAccountLegend(codes, await getAccountNameMap());
}

const confirmField = z
  .boolean()
  .optional()
  .describe(
    "Set to true to actually execute this write. If omitted or false, the tool returns a preview describing what would happen and writes NOTHING to Xero (it may make a read-only lookup to name the accounts involved). After receiving a preview, show it to the user verbatim, summarize the impact in plain English, and wait for explicit approval before re-calling with confirm: true.",
  );

export function requireWriteConfirmation(
  action: WriteAction,
  tool: ToolDefinition<ZodRawShapeCompat>,
): ToolDefinition<ZodRawShapeCompat> {
  const wrappedSchema: ZodRawShapeCompat = {
    ...(tool.schema as ZodRawShapeCompat),
    confirm: confirmField,
  };

  const wrappedHandler = (async (args: Record<string, unknown>, extra: unknown) => {
    const confirmed = args?.confirm === true;
    const rest = { ...(args ?? {}) };
    delete rest.confirm;

    if (!confirmed) {
      const legend = await accountLegend(rest);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `[CONFIRMATION REQUIRED — no data was written]`,
              `Tool: ${tool.name} (${action})`,
              ``,
              `Proposed parameters:`,
              "```json",
              JSON.stringify(rest, null, 2),
              "```",
              legend ? `\n${legend}` : null,
              ``,
              `Show this preview to the user, summarize what it will do in plain English (refer to accounts by name, not code), and wait for their explicit approval. To execute, re-call ${tool.name} with the same parameters plus "confirm": true.`,
            ]
              .filter((line) => line !== null)
              .join("\n"),
          },
        ],
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tool.handler as any)(rest, extra);
  }) as ToolDefinition<ZodRawShapeCompat>["handler"];

  return {
    name: tool.name,
    description:
      `${tool.description}\n\n[REQUIRES CONFIRMATION] First call returns a preview only. Re-call with confirm=true after the user explicitly approves.`,
    schema: wrappedSchema,
    handler: wrappedHandler,
  };
}
