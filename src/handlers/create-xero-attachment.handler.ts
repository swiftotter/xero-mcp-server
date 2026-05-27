import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Attachment } from "xero-node";

import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";

export type AttachmentEntityType = "invoice" | "banktransaction";

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

const ONE_SOURCE_ERROR =
  "Provide exactly one of filePath or fileContent (base64).";

function decodeBase64(fileContent: string): Buffer {
  // Tolerate a data URI prefix such as "data:application/pdf;base64,...".
  const comma = fileContent.indexOf(",");
  const raw =
    fileContent.startsWith("data:") && comma !== -1
      ? fileContent.slice(comma + 1)
      : fileContent;
  const normalized = raw.replace(/\s/g, "");

  // Buffer.from(..., "base64") silently drops invalid characters, which would
  // upload truncated/garbage bytes as a "successful" attachment. Validate first
  // so a malformed payload fails loudly instead of corrupting the file.
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error(
      "fileContent is not valid base64. Provide standard base64-encoded " +
        "file bytes (optionally as a data: URI).",
    );
  }

  const body = Buffer.from(normalized, "base64");
  if (body.length === 0) {
    throw new Error("fileContent decoded to zero bytes; nothing to upload.");
  }
  return body;
}

// resolveBody owns all input-mode validation: exactly one of filePath /
// fileContent, plus the rules specific to whichever was supplied.
async function resolveBody(
  filePath: string | undefined,
  fileContent: string | undefined,
  fileName: string | undefined,
): Promise<{ body: Buffer; fileName: string }> {
  const hasContent = fileContent !== undefined && fileContent !== "";
  const hasPath = filePath !== undefined && filePath !== "";

  if (hasContent === hasPath) {
    throw new Error(ONE_SOURCE_ERROR);
  }

  if (fileContent !== undefined && fileContent !== "") {
    if (!fileName) {
      throw new Error("fileName is required when uploading via fileContent.");
    }
    return { body: decodeBase64(fileContent), fileName };
  }

  // Only filePath remains; re-narrow for TypeScript.
  if (filePath === undefined || filePath === "") {
    throw new Error(ONE_SOURCE_ERROR);
  }

  const resolvedPath = path.resolve(expandHome(filePath));
  let body: Buffer;
  try {
    body = await fs.readFile(resolvedPath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        `Could not read file at ${resolvedPath}. The MCP server may be sandboxed ` +
          `and unable to see local files. Pass the file as base64 via "fileContent" ` +
          `(plus "fileName") instead of "filePath".`,
      );
    }
    throw error;
  }

  return { body, fileName: fileName ?? path.basename(resolvedPath) };
}

async function uploadAttachment(
  entityType: AttachmentEntityType,
  entityId: string,
  filePath: string | undefined,
  fileContent: string | undefined,
  fileName: string | undefined,
  includeOnline: boolean | undefined,
): Promise<Attachment | undefined> {
  const { body, fileName: resolvedFileName } = await resolveBody(
    filePath,
    fileContent,
    fileName,
  );

  await xeroClient.authenticate();

  switch (entityType) {
    case "invoice": {
      const response =
        await xeroClient.accountingApi.createInvoiceAttachmentByFileName(
          xeroClient.tenantId,
          entityId,
          resolvedFileName,
          body,
          includeOnline,
          undefined, // idempotencyKey
          getClientHeaders(),
        );
      return response.body.attachments?.[0];
    }
    case "banktransaction": {
      const response =
        await xeroClient.accountingApi.createBankTransactionAttachmentByFileName(
          xeroClient.tenantId,
          entityId,
          resolvedFileName,
          body,
          undefined, // idempotencyKey
          getClientHeaders(),
        );
      return response.body.attachments?.[0];
    }
  }
}

export async function createXeroAttachment(
  entityType: AttachmentEntityType,
  entityId: string,
  filePath: string | undefined,
  fileContent: string | undefined,
  fileName?: string,
  includeOnline?: boolean,
): Promise<XeroClientResponse<Attachment>> {
  try {
    const attachment = await uploadAttachment(
      entityType,
      entityId,
      filePath,
      fileContent,
      fileName,
      includeOnline,
    );

    if (!attachment) {
      throw new Error("Attachment upload failed.");
    }

    return {
      result: attachment,
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
