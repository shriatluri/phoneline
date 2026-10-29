import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

describe("phoneline server", () => {
  it("initializes and lists tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe("phoneline");
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);

    await client.close();
  });
});
