import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { STATUS_FRESH_MS, countUnread, readCursor, unreadItems } from "./unread.js";

describe("unread", () => {
  let dir: string;
  let store: Store;
  const now = 1_000_000_000_000;
  const unread = (me: string, cursor = 0) =>
    unreadItems(store.db, me, cursor, now).map((i) => [i.kind, i.from, i.text ?? i.question]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoneline-unread-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows other agents' statuses but not my own", () => {
    store.setStatus("me", "mine", now);
    store.setStatus("api", "building routes", now);
    expect(unread("me")).toEqual([["status", "api", "building routes"]]);
  });

  it("hides statuses older than 24 hours", () => {
    store.setStatus("api", "stale", now - STATUS_FRESH_MS - 1);
    store.setStatus("ui", "fresh", now - STATUS_FRESH_MS);
    expect(unread("me")).toEqual([["status", "ui", "fresh"]]);
  });

  it("shows open questions for me or anyone, but not for others", () => {
    store.createThread("api", "for anyone", null, now);
    store.createThread("api", "for me", "me", now);
    store.createThread("api", "for ui", "ui", now);
    store.createThread("me", "my own question", null, now);
    expect(unread("me")).toEqual([
      ["question", "api", "for anyone"],
      ["question", "api", "for me"],
    ]);
  });

  it("shows answers to my questions only, once answered", () => {
    const mine = store.createThread("me", "which port?", null, now);
    const theirs = store.createThread("ui", "which db?", null, now);
    store.answerThread(mine.id, "api", "3000", now);
    store.answerThread(theirs.id, "api", "sqlite", now);
    expect(unread("me")).toEqual([["answer", "api", "3000"]]);
  });

  it("drops a question from unread once someone answers it", () => {
    const t = store.createThread("api", "anyone know?", null, now);
    store.answerThread(t.id, "ui", "yes", now);
    expect(unread("me")).toEqual([]);
  });

  it("does not count my own answer to my own question", () => {
    const t = store.createThread("me", "note to self", null, now);
    store.answerThread(t.id, "me", "done", now);
    expect(unread("me")).toEqual([]);
  });

  it("respects the cursor and orders by seq", () => {
    store.setStatus("api", "one", now);
    const cursor = store.currentSeq();
    store.createThread("ui", "two", null, now);
    store.setStatus("api", "three", now); // overwrite moves it past the cursor
    expect(unread("me", cursor)).toEqual([
      ["question", "ui", "two"],
      ["status", "api", "three"],
    ]);
  });

  it("counts the same items the list returns", () => {
    store.setStatus("api", "busy", now);
    store.createThread("api", "for me", "me", now);
    store.createThread("ui", "for anyone", null, now);
    store.createThread("ui", "for someone else", "api", now);
    expect(countUnread(store.db, "me", 0, now)).toEqual({ total: 3, questionsForMe: 1 });
    // A new agent sees the status and the question for anyone.
    expect(countUnread(store.db, "nobody-yet", 0, now)).toEqual({ total: 2, questionsForMe: 0 });
    expect(unreadItems(store.db, "me", 0, now)).toHaveLength(3);
    expect(countUnread(store.db, "me", store.currentSeq(), now)).toEqual({ total: 0, questionsForMe: 0 });
  });

  it("reads cursors, defaulting to 0", () => {
    expect(readCursor(store.db, "me")).toBe(0);
    store.setCursor("me", 7);
    expect(readCursor(store.db, "me")).toBe(7);
  });
});
