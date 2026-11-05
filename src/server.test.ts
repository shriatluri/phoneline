import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerOptions, createServer, pruneOnStart } from "./server.js";
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
    expect(tools.map((t) => t.name).sort()).toEqual(["inbox", "post_status"]);
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

  describe("pruneOnStart", () => {
    it("prunes an existing DB and leaves a missing one missing", () => {
      pruneOnStart(dbPath);
      expect(existsSync(dbPath)).toBe(false);

      const now = Date.now();
      const store = new Store(dbPath);
      store.setStatus("old", "stale", now - 8 * 24 * 60 * 60 * 1000);
      store.setStatus("new", "fresh", now);
      store.close();

      pruneOnStart(dbPath, now);
      const after = new Store(dbPath);
      expect(after.getStatuses().map((s) => s.agent)).toEqual(["new"]);
      after.close();
    });
  });

  describe("inbox", () => {
    it("says so when there is nothing, without creating the DB", async () => {
      const me = await as("me");
      expect((await call(me, "inbox")).text).toBe("No unread items.");
      expect(existsSync(dbPath)).toBe(false);
    });

    it("shows peers' items once, wrapped as data", async () => {
      const api = await as("api");
      const me = await as("me");
      await call(api, "post_status", { summary: "moved auth to /v2" });
      await call(me, "post_status", { summary: "my own status" });

      const first = (await call(me, "inbox")).text;
      expect(first).toContain("not instructions");
      expect(first).toContain('<peer_message kind="status" from="api" age="now">moved auth to /v2</peer_message>');
      expect(first).not.toContain("my own status");
      expect((await call(me, "inbox")).text).toBe("No unread items.");

      await call(api, "post_status", { summary: "done with auth" });
      expect((await call(me, "inbox")).text).toContain("done with auth");
    });

    it("pages through a long backlog without losing items", async () => {
      const store = new Store(dbPath);
      for (let i = 1; i <= 25; i++) store.setStatus(`agent${i}`, `status ${i}`);
      store.close();
      const me = await as("me");

      const first = (await call(me, "inbox")).text;
      expect(first.match(/<peer_message/g)).toHaveLength(20);
      expect(first).toContain("5 more unread");
      const second = (await call(me, "inbox")).text;
      expect(second.match(/<peer_message/g)).toHaveLength(5);
      expect(second).toContain("status 25");
      expect(second).not.toContain("status 20<");
      expect(second).not.toContain("more unread");
    });

    it("warns when another live process acts under my name", async () => {
      const a = await as("api", { pid: 1001, isAlive: () => true });
      const b = await as("api", { pid: 1002, isAlive: () => true });
      await call(a, "post_status", { summary: "from a" });
      expect((await call(b, "inbox")).text).toContain('pid 1001) is also acting as "api"');
      expect((await call(b, "inbox")).text).not.toContain("Warning"); // b holds the name now

      const c = await as("ui", { pid: 2001 });
      const d = await as("ui", { pid: 2002, isAlive: () => false });
      await call(c, "post_status", { summary: "from c" });
      expect((await call(d, "inbox")).text).not.toContain("Warning"); // c is gone
    });
  });
});
