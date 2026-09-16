import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createContext, type ToolContext } from "./context.js";
import { registerWhoamiTool } from "./tools/whoami.js";
import { registerProjectTools } from "./tools/project.js";
import { RESOURCES } from "./resources.js";
import { registerCrudTools } from "./tools/crud.js";
import { registerCommentTools } from "./tools/comment.js";
import { registerSearchTool } from "./tools/search.js";
import { registerBulkTool } from "./tools/bulk.js";
import { registerStatsTool } from "./tools/stats.js";
import { registerAttachmentTools } from "./tools/attachment.js";
import { registerLinkTool } from "./tools/link.js";

export function createServer(ctx: ToolContext = createContext()): McpServer {
  const server = new McpServer({ name: "taiga", version: "0.2.0" });
  registerWhoamiTool(server, ctx);
  registerProjectTools(server, ctx);
  for (const def of RESOURCES) registerCrudTools(server, ctx, def);
  registerCommentTools(server, ctx);
  registerSearchTool(server, ctx);
  registerBulkTool(server, ctx);
  registerStatsTool(server, ctx);
  registerAttachmentTools(server, ctx);
  registerLinkTool(server, ctx);
  return server;
}
