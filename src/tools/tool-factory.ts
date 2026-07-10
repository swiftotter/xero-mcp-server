import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import { CreateTools } from "./create/index.js";
import { DeleteTools } from "./delete/index.js";
import { GetTools } from "./get/index.js";
import { ListTools } from "./list/index.js";
import { UpdateTools } from "./update/index.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import {
  requireWriteConfirmation,
  type WriteAction,
} from "../helpers/require-write-confirmation.js";

function inferUpdateAction(name: string): WriteAction {
  if (name.startsWith("approve-")) return "approve";
  if (name.startsWith("revert-")) return "revert";
  return "update";
}

// Register via the SDK's explicit `registerTool({ inputSchema })` API rather
// than the positional `server.tool(name, desc, schema, annotations, handler)`
// overload. The positional form relies on the SDK guessing which argument is
// the Zod raw shape and which is the annotations object; when that detection
// fails (e.g. a mismatched Zod copy on an older SDK) the schema is silently
// misread as annotations and the tool publishes an EMPTY input schema, which
// makes clients send every argument as a string and breaks confirmed writes.
// Passing the schema by an explicit named field removes that ambiguity for good.
function register(
  server: McpServer,
  tool: ToolDefinition<ZodRawShapeCompat>,
  annotations: ToolAnnotations,
): void {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema, annotations },
    tool.handler,
  );
}

// Category-level annotations. Claude Desktop groups tools by readOnlyHint:
// readOnly tools land in the "Search & view" group, the rest in the write
// group. destructiveHint flags the one delete tool so it sorts apart from
// regular creates/updates.
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const UPDATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export function ToolFactory(server: McpServer) {

  DeleteTools.map((tool) => tool())
    .map((tool) => requireWriteConfirmation("delete", tool))
    .forEach((tool) => register(server, tool, DELETE_ANNOTATIONS));
  GetTools.map((tool) => tool())
    .forEach((tool) => {
      // get-attachment writes a downloaded file to the local filesystem, so it
      // is NOT read-only: annotate it as a write and route it through the
      // confirmation gate so a prompt-injected client can't silently overwrite
      // files on the host. (In the hosted deployment the handler refuses the
      // write outright.) Every other Get tool is genuinely read-only.
      if (tool.name === "get-attachment") {
        register(server, requireWriteConfirmation("create", tool), CREATE_ANNOTATIONS);
        return;
      }
      register(server, tool, READ_ONLY_ANNOTATIONS);
    });
  CreateTools.map((tool) => tool())
    .map((tool) => requireWriteConfirmation("create", tool))
    .forEach((tool) => register(server, tool, CREATE_ANNOTATIONS));
  ListTools.map((tool) => tool())
    .forEach((tool) => register(server, tool, READ_ONLY_ANNOTATIONS));
  UpdateTools.map((tool) => tool())
    .map((tool) => requireWriteConfirmation(inferUpdateAction(tool.name), tool))
    .forEach((tool) => register(server, tool, UPDATE_ANNOTATIONS));
}
