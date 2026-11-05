import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export const VERSION = "0.0.1";

export function createServer(): McpServer {
  // Declaring the tools capability up front makes tools/list answer
  // (with an empty list) even before any tool is registered.
  const server = new McpServer(
    { name: "phoneline", version: VERSION },
    { capabilities: { tools: {} } },
  );

  // --- Tool registration ---------------------------------------------------
  // MVP tools land here in later tickets, e.g.:
  //   server.registerTool("post_status", { description, inputSchema }, handler)
  //   server.registerTool("inbox", ...)
  //   server.registerTool("ask", ...)
  //   server.registerTool("answer", ...)
  // -------------------------------------------------------------------------

  return server;
}

export async function startStdioServer(): Promise<void> {
  serveStdio(createServer);
  // stdout carries JSON-RPC, so any logging must go to stderr.
  console.error(`phoneline ${VERSION} MCP server running on stdio`);
}
