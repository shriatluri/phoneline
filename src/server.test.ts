import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerOptions, createServer } from "./server.js";
import { Store } from "./store.js";

/** A connected client acting as one agent. */
async function connect(opts: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(opts).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Call a tool and return its text, plus whether it was an error. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
}

describe("phoneline server", () => {
  let dir: string;
  let dbPath: string;
  const clients: Client[] = [];
  const as = async (name: string, extra: Partial<ServerOptions> = {}) => {
    const c = await connect({ dbPath, agent: () => name, ...extra });
    clients.push(c);
    return c;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoneline-server-"));
    dbPath = join(dir, "repo.db");
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("initializes and lists the tools", async () => {
    const client = await as("me");
    expect(client.getServerVersion()?.name).toBe("phoneline");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["post_status"]);
  });

  it("does not create the DB just by starting", async () => {
    await as("me");
    expect(existsSync(dbPath)).toBe(false);
  });

  describe("post_status", () => {
    it("overwrites my status", async () => {
      const me = await as("api", { pid: 111 });
      expect((await call(me, "post_status", { summary: "  building routes " })).text).toBe("Status posted as api.");
      await call(me, "post_status", { summary: "writing tests" });

      const store = new Store(dbPath);
      expect(store.getStatuses().map((s) => [s.agent, s.summary])).toEqual([["api", "writing tests"]]);
      expect(store.getAgent("api")?.server_pid).toBe(111);
      store.close();
    });

    it("rejects an over-long or empty status instead of truncating", async () => {
      const me = await as("api");
      const long = await call(me, "post_status", { summary: "x".repeat(281) });
      expect(long.isError).toBe(true);
      expect(long.text).toContain("over 280 chars");
      expect((await call(me, "post_status", { summary: "   " })).isError).toBe(true);
      expect(existsSync(dbPath)).toBe(false); // nothing was written
      expect((await call(me, "post_status", { summary: "x".repeat(280) })).isError).toBe(false);
    });
  });
});
