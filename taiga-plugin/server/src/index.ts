import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext, type ToolContext } from "./context.js";
import { registerWhoamiTool } from "./tools/whoami.js";
import { registerProjectTools } from "./tools/project.js";
import { RESOURCES } from "./resources.js";
import { registerCrudTools } from "./tools/crud.js";
import { registerCommentTools } from "./tools/comment.js";
import { registerSearchTool } from "./tools/search.js";
import { registerBulkTool } from "./tools/bulk.js";

export function createServer(ctx: ToolContext = createContext()): McpServer {
  const server = new McpServer({ name: "taiga", version: "0.1.0" });
  registerWhoamiTool(server, ctx);
  registerProjectTools(server, ctx);
  for (const def of RESOURCES) registerCrudTools(server, ctx, def);
  registerCommentTools(server, ctx);
  registerSearchTool(server, ctx);
  registerBulkTool(server, ctx);
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Under vitest the server is constructed by the test helper, not by main().
if (process.env.VITEST === undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
