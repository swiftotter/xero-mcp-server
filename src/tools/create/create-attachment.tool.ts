import { z } from "zod";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { createXeroAttachment } from "../../handlers/create-xero-attachment.handler.js";

const CreateAttachmentTool = CreateXeroTool(
  "create-attachment",
  `Upload a file as an attachment on a Xero invoice or bank transaction.

  Provide the file in ONE of two ways:
  - fileContent: the file's bytes, base64-encoded. Prefer this — the MCP server is
    often sandboxed and cannot read local file paths. Requires fileName.
  - filePath: a path the SERVER can read (absolute, or relative to the server's
    working directory; a leading ~ is expanded). Only works when the server has
    filesystem access to that path; otherwise it fails and you should fall back to
    fileContent. If fileName is omitted, the basename of filePath is used.

  includeOnline only applies to invoices and controls whether the attachment
  is shown on the online invoice the customer sees.
  After upload, the entity's hasAttachments flag will be true.`,
  {
    entityType: z.enum(["invoice", "banktransaction"]).describe(
      "The type of entity to attach the file to. \"invoice\" for an Invoice (use the InvoiceID), \"banktransaction\" for a BankTransaction (use the BankTransactionID).",
    ),
    entityId: z
      .string()
      .describe("The ID of the invoice or bank transaction to attach the file to."),
    fileContent: z
      .string()
      .optional()
      .describe(
        "Base64-encoded file bytes. Preferred: works even when the server cannot read local paths (the sandboxed default). Requires fileName. Provide either fileContent or filePath, not both.",
      ),
    filePath: z
      .string()
      .optional()
      .describe(
        "Path to a file the SERVER can read (absolute or relative to the server's working directory; a leading ~ is expanded). Only use when the server has filesystem access; otherwise use fileContent. Provide either fileContent or filePath, not both.",
      ),
    fileName: z
      .string()
      .optional()
      .describe(
        "The attachment's stored file name (e.g. \"confirmation.pdf\"). Required when using fileContent. With filePath, defaults to the basename of the path.",
      ),
    includeOnline: z
      .boolean()
      .optional()
      .describe(
        "Invoices only: include the attachment on the online (customer-facing) invoice. Ignored for bank transactions.",
      ),
  },
  async ({ entityType, entityId, fileContent, filePath, fileName, includeOnline }) => {
    const result = await createXeroAttachment(
      entityType,
      entityId,
      filePath,
      fileContent,
      fileName,
      includeOnline,
    );

    if (result.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error uploading attachment: ${result.error}`,
          },
        ],
      };
    }

    const attachment = result.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Attachment uploaded to ${entityType} ${entityId}:`,
            `Attachment ID: ${attachment.attachmentID}`,
            `File Name: ${attachment.fileName}`,
            attachment.mimeType ? `Mime Type: ${attachment.mimeType}` : null,
            attachment.contentLength !== undefined
              ? `Content Length: ${attachment.contentLength} bytes`
              : null,
            attachment.url ? `URL: ${attachment.url}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default CreateAttachmentTool;
