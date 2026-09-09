import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createServer(): McpServer {
  const server = new McpServer({ name: "taiga", version: "0.1.0" });

  server.tool(
    "taiga_whoami",
    "Show the authenticated Taiga user, their projects and roles. " +
      "Use this first to confirm the connection works.",
    {},
    async () => ({
      content: [{ type: "text" as const, text: "not implemented yet" }],
    }),
  );

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
