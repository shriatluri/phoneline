import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store, defaultDbPath, repoKey } from "./store.js";

describe("Store", () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoneline-test-"));
    dbPath = join(dir, "nested", "test.db"); // also checks the directory gets created
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schema with WAL enabled", () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["agents", "meta", "read_cursors", "statuses", "threads"]));
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");

    // Reopening an existing file is a no-op for the schema.
    store.close();
    store = new Store(dbPath);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("overwrites an agent's status", () => {
    const first = store.setStatus("alice", "reading the codebase");
    const second = store.setStatus("alice", "writing the store");
    store.setStatus("bob", "idle");

    const statuses = store.getStatuses();
    expect(statuses.map((s) => [s.agent, s.summary])).toEqual([
      ["alice", "writing the store"],
      ["bob", "idle"],
    ]);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(store.getStatuses(second.seq).map((s) => s.agent)).toEqual(["bob"]);
  });

  it("creates and answers a thread", () => {
    const thread = store.createThread("alice", "Which zod import do we use?", "bob");
    expect(thread).toMatchObject({ from_agent: "alice", to_agent: "bob", answer: null, resolved: 0 });
    expect(store.getThreads({ openOnly: true }).map((t) => t.id)).toEqual([thread.id]);

    const answered = store.answerThread(thread.id, "bob", "plain `zod`");
    expect(answered).toMatchObject({ answer: "plain `zod`", answered_by: "bob", resolved: 1 });
    expect(answered!.seq).toBeGreaterThan(thread.seq); // the asker sees the answer as new
    expect(store.getThreads({ openOnly: true })).toEqual([]);
    expect(store.answerThread(9999, "bob", "nope")).toBeUndefined();
  });

  it("round-trips read cursors", () => {
    expect(store.getCursor("alice")).toBe(0);
    store.setStatus("bob", "hello");
    store.setCursor("alice", store.currentSeq());
    expect(store.getCursor("alice")).toBe(store.currentSeq());

    store.setStatus("bob", "new news");
    expect(store.getStatuses(store.getCursor("alice")).map((s) => s.summary)).toEqual(["new news"]);
  });

  it("lets two connections to the same file both write", () => {
    const other = new Store(dbPath);
    try {
      store.setStatus("alice", "from connection 1");
      other.setStatus("bob", "from connection 2");
      const t = other.createThread("bob", "anyone around?");
      store.answerThread(t.id, "alice", "yes");

      expect(store.getStatuses().map((s) => s.agent)).toEqual(["alice", "bob"]);
      expect(other.getThread(t.id)?.answer).toBe("yes");
      expect(store.currentSeq()).toBe(4); // one shared, monotonic counter
    } finally {
      other.close();
    }
  });
});

describe("db path", () => {
  it("derives a readable, unique repo key", () => {
    expect(repoKey("/Users/me/code/My App")).toMatch(/^my-app-[0-9a-f]{8}$/);
    expect(repoKey("/a/phoneline")).not.toBe(repoKey("/b/phoneline"));
  });

  it("honors PHONELINE_DB", () => {
    const prev = process.env.PHONELINE_DB;
    process.env.PHONELINE_DB = "/tmp/custom.db";
    try {
      expect(defaultDbPath()).toBe("/tmp/custom.db");
    } finally {
      if (prev === undefined) delete process.env.PHONELINE_DB;
      else process.env.PHONELINE_DB = prev;
    }
  });
});
