import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { agentName } from "./identity.js";
import { Store, defaultDbPath, openStore } from "./store.js";

export const VERSION = "0.0.1";

export const LIMITS = { status: 280 };

export interface ServerOptions {
  /** DB file; defaults to the repo's DB under ~/.phoneline. */
  dbPath?: string;
  /** Who "me" is; resolved on every call so a branch switch takes effect. */
  agent?: () => string;
  now?: () => number;
  /** This server's process id, recorded so inbox can spot a shared name. */
  pid?: number;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createServer(opts: ServerOptions = {}): McpServer {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const agent = opts.agent ?? (() => agentName());
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;

  // The DB is created on the first write, so a repo that never uses
  // phoneline gets no file. Reads before then see an empty DB.
  let store: Store | undefined;
  const existingStore = () => (store ??= openStore(dbPath));
  const writableStore = () => (store ??= openStore(dbPath, { create: true })!);

  const server = new McpServer({ name: "phoneline", version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "post_status",
    {
      description:
        "Tell the other agents on this repo what you're working on. Overwrites your previous status. " +
        `Keep it to one or two sentences (max ${LIMITS.status} chars): what you're doing and anything ` +
        "others should know, e.g. a changed interface. Post when you start or switch tasks.",
      inputSchema: z.object({
        summary: z
          .string()
          .trim()
          .min(1, "Status is empty.")
          .max(LIMITS.status, `Status is over ${LIMITS.status} chars. Shorten it and post again.`),
      }),
    },
    async ({ summary }) => {
      const me = agent();
      const s = writableStore();
      s.setStatus(me, summary, now());
      s.registerAgent(me, now(), pid);
      return text(`Status posted as ${me}.`);
    },
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  serveStdio(() => createServer());
  // stdout carries JSON-RPC, so any logging must go to stderr.
  console.error(`phoneline ${VERSION} MCP server running on stdio`);
}
