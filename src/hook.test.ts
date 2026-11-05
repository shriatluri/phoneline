import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadHint } from "./hook.js";
import { Store } from "./store.js";

describe("unreadHint", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoneline-hook-"));
    dbPath = join(dir, "repo.db");
  });

  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on a missing DB rather than creating one", () => {
    expect(() => unreadHint(dbPath, "me")).toThrow();
  });

  it("is silent at zero, and counts questions for me", () => {
    const store = new Store(dbPath);
    store.setStatus("me", "my own");
    expect(unreadHint(dbPath, "me")).toBeUndefined();

    store.setStatus("api", "busy");
    expect(unreadHint(dbPath, "me")).toBe("phoneline: 1 unread. Call inbox.");
    store.createThread("api", "q1", "me");
    expect(unreadHint(dbPath, "me")).toBe("phoneline: 2 unread (1 question for you). Call inbox.");
    store.createThread("ui", "q2", "me");
    store.createThread("ui", "q3"); // for anyone: unread, but not "for you"
    expect(unreadHint(dbPath, "me")).toBe("phoneline: 4 unread (2 questions for you). Call inbox.");

    store.setCursor("me", store.currentSeq());
    expect(unreadHint(dbPath, "me")).toBeUndefined();
    store.close();
  });

  it("reads while another connection is writing, and from a read-only file", () => {
    const writer = new Store(dbPath);
    writer.setStatus("api", "busy");
    writer.db.prepare("BEGIN IMMEDIATE").run(); // hold the write lock
    expect(unreadHint(dbPath, "me")).toBe("phoneline: 1 unread. Call inbox.");
    writer.db.prepare("ROLLBACK").run();
    writer.close();

    chmodSync(dbPath, 0o444);
    expect(unreadHint(dbPath, "me")).toBe("phoneline: 1 unread. Call inbox.");
  });
});
