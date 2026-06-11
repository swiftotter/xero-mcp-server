import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { CreateTools } from "./create/index.js";
import { DeleteTools } from "./delete/index.js";
import { GetTools } from "./get/index.js";
import { ListTools } from "./list/index.js";
import { UpdateTools } from "./update/index.js";
import {
  requireWriteConfirmation,
  type WriteAction,
} from "../helpers/require-write-confirmation.js";

function inferUpdateAction(name: string): WriteAction {
  if (name.startsWith("approve-")) return "approve";
  if (name.startsWith("revert-")) return "revert";
  return "update";
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
    .forEach((tool) =>
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        DELETE_ANNOTATIONS,
        tool.handler,
      ),
    );
  GetTools.map((tool) => tool())
    .forEach((tool) => {
      // get-attachment writes a downloaded file to the local filesystem, so it
      // is NOT read-only: annotate it as a write and route it through the
      // confirmation gate so a prompt-injected client can't silently overwrite
      // files on the host. (In the hosted deployment the handler refuses the
      // write outright.) Every other Get tool is genuinely read-only.
      if (tool.name === "get-attachment") {
        const gated = requireWriteConfirmation("create", tool);
        server.tool(
          gated.name,
          gated.description,
          gated.schema,
          CREATE_ANNOTATIONS,
          gated.handler,
        );
        return;
      }
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        READ_ONLY_ANNOTATIONS,
        tool.handler,
      );
    });
  CreateTools.map((tool) => tool())
    .map((tool) => requireWriteConfirmation("create", tool))
    .forEach((tool) =>
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        CREATE_ANNOTATIONS,
        tool.handler,
      ),
    );
  ListTools.map((tool) => tool())
    .forEach((tool) =>
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        READ_ONLY_ANNOTATIONS,
        tool.handler,
      ),
    );
  UpdateTools.map((tool) => tool())
    .map((tool) => requireWriteConfirmation(inferUpdateAction(tool.name), tool))
    .forEach((tool) =>
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        UPDATE_ANNOTATIONS,
        tool.handler,
      ),
    );
}
