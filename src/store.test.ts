import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store, defaultDbPath, openStore, repoKey, repoRoot } from "./store.js";

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
    expect(thread).toMatchObject({ from_agent: "alice", to_agent: "bob", answer: null });
    expect(store.getThreads({ openOnly: true }).map((t) => t.id)).toEqual([thread.id]);

    const answered = store.answerThread(thread.id, "bob", "plain `zod`");
    expect(answered?.won).toBe(true);
    expect(answered?.thread).toMatchObject({ answer: "plain `zod`", answered_by: "bob" });
    expect(answered!.thread.seq).toBeGreaterThan(thread.seq); // the asker sees the answer as new
    expect(store.getThreads({ openOnly: true })).toEqual([]);
    expect(store.answerThread(9999, "bob", "nope")).toBeUndefined();
  });

  it("keeps the first answer", () => {
    const thread = store.createThread("alice", "Which port?");
    store.answerThread(thread.id, "bob", "3000");
    const seq = store.currentSeq();

    const second = store.answerThread(thread.id, "carol", "8080");
    expect(second?.won).toBe(false);
    expect(second?.thread).toMatchObject({ answer: "3000", answered_by: "bob" });
    expect(store.getThread(thread.id)?.answer).toBe("3000");
    expect(store.currentSeq()).toBe(seq); // a losing answer writes nothing
  });

  it("records which server pid acts as an agent", () => {
    expect(store.registerAgent("alice").server_pid).toBeNull();
    expect(store.registerAgent("alice", Date.now(), 4242).server_pid).toBe(4242);
    expect(store.registerAgent("alice").server_pid).toBe(4242); // writes without a pid keep it
  });

  it("prunes old statuses and threads", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    store.setStatus("old", "stale", now - 8 * day);
    store.setStatus("new", "fresh", now - 6 * day);
    store.createThread("a", "old open", null, now - 8 * day);
    store.createThread("a", "new open", null, now - 6 * day);
    const oldAnswered = store.createThread("a", "old answered", null, now - 40 * day);
    store.answerThread(oldAnswered.id, "b", "x", now - 31 * day);
    const keptAnswered = store.createThread("a", "kept answered", null, now - 40 * day);
    store.answerThread(keptAnswered.id, "b", "y", now - 20 * day); // answered 20 days ago: keep

    expect(store.prune(now)).toEqual({ statuses: 1, threads: 2 });
    expect(store.getStatuses().map((s) => s.agent)).toEqual(["new"]);
    expect(store.getThreads().map((t) => t.question).sort()).toEqual(["kept answered", "new open"]);
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

describe("openStore", () => {
  it("creates the DB only when asked to", () => {
    const dir = mkdtempSync(join(tmpdir(), "phoneline-lazy-"));
    const path = join(dir, "sub", "repo.db");
    try {
      expect(openStore(path)).toBeUndefined();
      expect(existsSync(join(dir, "sub"))).toBe(false); // not even the directory

      const created = openStore(path, { create: true })!;
      created.setStatus("alice", "hi");
      created.close();

      const reopened = openStore(path)!;
      expect(reopened.getStatuses()).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("db path", () => {
  it("derives a readable, unique repo key", () => {
    expect(repoKey("/Users/me/code/My App/.git")).toMatch(/^my-app-[0-9a-f]{8}$/);
    expect(repoKey("/srv/phoneline.git")).toMatch(/^phoneline-[0-9a-f]{8}$/); // bare repo
    expect(repoKey("/a/phoneline/.git")).not.toBe(repoKey("/b/phoneline/.git"));
  });

  it("gives a checkout, its subdirectories, and its worktrees one DB", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "phoneline-git-")));
    try {
      const main = join(dir, "app");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
      mkdirSync(join(main, "src"), { recursive: true });
      git("init", "-q", "-b", "main");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
      git("worktree", "add", "-q", join(dir, "app-feature"), "-b", "feature");

      expect(repoRoot(main)).toBe(join(main, ".git"));
      const path = defaultDbPath(main);
      expect(path).toMatch(/app-[0-9a-f]{8}\.db$/);
      expect(defaultDbPath(join(main, "src"))).toBe(path);
      expect(defaultDbPath(join(dir, "app-feature"))).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the directory itself outside git", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "phoneline-nogit-")));
    try {
      expect(repoRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
