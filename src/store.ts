import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long rows live before prune() deletes them. */
export const RETENTION = {
  statusMs: 7 * DAY_MS,
  openThreadMs: 7 * DAY_MS,
  // Answered threads are the dedupe corpus for ask, so they live longer.
  answeredThreadMs: 30 * DAY_MS,
};

// Every write bumps one global counter (meta.seq) and stamps the row it touched
// with the new value. Read cursors store the last seq an agent has seen, so
// "what is new to me" is just `WHERE seq > cursor`. We use a counter instead of
// timestamps because two processes can write in the same millisecond and wall
// clocks can move backwards; the counter is bumped inside a write transaction,
// and SQLite allows one writer at a time, so it is strictly increasing.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION}), ('seq', 0);

CREATE TABLE IF NOT EXISTS agents (
  name          TEXT PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  server_pid    INTEGER          -- last MCP server process to act as this agent
);

CREATE TABLE IF NOT EXISTS statuses (
  agent      TEXT PRIMARY KEY REFERENCES agents(name),
  summary    TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  seq        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent  TEXT NOT NULL REFERENCES agents(name),
  to_agent    TEXT,            -- NULL means "anyone"
  question    TEXT NOT NULL,
  answer      TEXT,
  answered_by TEXT,
  created_at  INTEGER NOT NULL,
  answered_at INTEGER,
  seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS read_cursors (
  agent    TEXT PRIMARY KEY REFERENCES agents(name),
  last_seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS statuses_seq ON statuses(seq);
CREATE INDEX IF NOT EXISTS threads_seq ON threads(seq);
`;

export interface Agent {
  name: string;
  registered_at: number;
  last_seen_at: number;
  server_pid: number | null;
}

export interface Status {
  agent: string;
  summary: string;
  updated_at: number;
  seq: number;
}

export interface Thread {
  id: number;
  from_agent: string;
  to_agent: string | null;
  question: string;
  answer: string | null;
  answered_by: string | null;
  created_at: number;
  answered_at: number | null;
  seq: number;
}

/** The directory Claude Code was started in; the server and hook both resolve from here. */
export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * The repo's shared .git directory, or `cwd` itself when it is not inside a repo.
 * A main checkout and its worktrees all return the same path, so they share a DB.
 */
export function repoRoot(cwd = projectDir()): string {
  try {
    const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync(dir);
  } catch {
    return cwd;
  }
}

/** e.g. "/Users/me/code/My App/.git" -> "my-app-1a2b3c4d" */
export function repoKey(root: string): string {
  // The common dir is usually ".../<repo>/.git", so name it after its parent.
  const display = basename(root) === ".git" ? basename(dirname(root)) : basename(root, ".git");
  const name = display.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

/** PHONELINE_DB wins; otherwise ~/.phoneline/<repo-key>.db */
export function defaultDbPath(cwd = projectDir()): string {
  return process.env.PHONELINE_DB || join(homedir(), ".phoneline", `${repoKey(repoRoot(cwd))}.db`);
}

/**
 * Opens the store for a repo. Unless `create` is set, a missing file returns
 * undefined instead of creating one, so read-only paths (like an empty
 * inbox in a repo that never used phoneline) leave nothing behind.
 */
export function openStore(path = defaultDbPath(), { create = false } = {}): Store | undefined {
  if (!create && !existsSync(path)) return undefined;
  return new Store(path);
}

function retryBusy<T>(fn: () => T, attempts = 50, delayMs = 20): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if ((err as { code?: string }).code !== "SQLITE_BUSY" || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); // sync sleep
    }
  }
}

export class Store {
  readonly db: Database.Database;

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    // timeout = busy_timeout: wait up to 5s for another process's write lock.
    this.db = new Database(path, { timeout: 5000 });
    this.db.pragma("foreign_keys = ON");
    // Switching a new file to WAL needs an exclusive lock and can fail with
    // SQLITE_BUSY without honoring the busy timeout, e.g. when several
    // terminals start at once. Retry briefly.
    retryBusy(() => this.db.pragma("journal_mode = WAL"));
    this.write(() => this.db.exec(SCHEMA));
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return this.metaValue("schema_version");
  }

  /** Highest seq written so far. */
  currentSeq(): number {
    return this.metaValue("seq");
  }

  // --- agents ---------------------------------------------------------------

  /**
   * Insert the agent, or bump last_seen_at if it already exists. Pass the
   * server's pid to record which process is acting as this agent.
   */
  registerAgent(name: string, now = Date.now(), serverPid?: number): Agent {
    return this.db
      .prepare(
        `INSERT INTO agents (name, registered_at, last_seen_at, server_pid) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           server_pid = coalesce(excluded.server_pid, server_pid)
         RETURNING *`,
      )
      .get(name, now, now, serverPid ?? null) as Agent;
  }

  getAgent(name: string): Agent | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as Agent | undefined;
  }

  getAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY name").all() as Agent[];
  }

  // --- statuses -------------------------------------------------------------

  /** One status per agent; a new one overwrites the old one. */
  setStatus(agent: string, summary: string, now = Date.now()): Status {
    return this.write(() => {
      this.registerAgent(agent, now);
      const seq = this.nextSeq();
      return this.db
        .prepare(
          `INSERT INTO statuses (agent, summary, updated_at, seq) VALUES (?, ?, ?, ?)
           ON CONFLICT(agent) DO UPDATE SET
             summary = excluded.summary, updated_at = excluded.updated_at, seq = excluded.seq
           RETURNING *`,
        )
        .get(agent, summary, now, seq) as Status;
    });
  }

  /** All statuses, or only those written after `sinceSeq`. */
  getStatuses(sinceSeq = 0): Status[] {
    return this.db
      .prepare("SELECT * FROM statuses WHERE seq > ? ORDER BY seq")
      .all(sinceSeq) as Status[];
  }

  // --- threads --------------------------------------------------------------

  createThread(fromAgent: string, question: string, toAgent: string | null = null, now = Date.now()): Thread {
    return this.write(() => {
      this.registerAgent(fromAgent, now);
      const seq = this.nextSeq();
      return this.db
        .prepare(
          `INSERT INTO threads (from_agent, to_agent, question, created_at, seq)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(fromAgent, toAgent, question, now, seq) as Thread;
    });
  }

  /**
   * Records the answer if the thread has none yet: the first answer wins.
   * `won` is false when someone already answered; `thread` then shows who.
   * Returns undefined if the id is unknown.
   */
  answerThread(
    id: number,
    answeredBy: string,
    answer: string,
    now = Date.now(),
  ): { thread: Thread; won: boolean } | undefined {
    return this.write(() => {
      const existing = this.getThread(id);
      if (!existing) return undefined;
      if (existing.answer !== null) return { thread: existing, won: false };

      this.registerAgent(answeredBy, now);
      const seq = this.nextSeq();
      const thread = this.db
        .prepare(
          `UPDATE threads SET answer = ?, answered_by = ?, answered_at = ?, seq = ?
           WHERE id = ? AND answer IS NULL RETURNING *`,
        )
        .get(answer, answeredBy, now, seq, id) as Thread;
      return { thread, won: true };
    });
  }

  getThread(id: number): Thread | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
  }

  /** Threads created or answered after `sinceSeq`; `openOnly` keeps unanswered ones. */
  getThreads({ sinceSeq = 0, openOnly = false } = {}): Thread[] {
    return this.db
      .prepare(`SELECT * FROM threads WHERE seq > ? ${openOnly ? "AND answer IS NULL" : ""} ORDER BY seq`)
      .all(sinceSeq) as Thread[];
  }

  // --- read cursors ---------------------------------------------------------

  /** Last seq this agent has read; 0 if it has never read. */
  getCursor(agent: string): number {
    const row = this.db.prepare("SELECT last_seq FROM read_cursors WHERE agent = ?").get(agent) as
      | { last_seq: number }
      | undefined;
    return row?.last_seq ?? 0;
  }

  setCursor(agent: string, lastSeq: number): void {
    this.write(() => {
      this.registerAgent(agent);
      this.db
        .prepare(
          `INSERT INTO read_cursors (agent, last_seq) VALUES (?, ?)
           ON CONFLICT(agent) DO UPDATE SET last_seq = excluded.last_seq`,
        )
        .run(agent, lastSeq);
    });
  }

  // --- retention ------------------------------------------------------------

  /** Delete old statuses and threads (see RETENTION). Returns how many rows went. */
  prune(now = Date.now()): { statuses: number; threads: number } {
    return this.write(() => {
      const statuses = this.db
        .prepare("DELETE FROM statuses WHERE updated_at < ?")
        .run(now - RETENTION.statusMs).changes;
      const threads = this.db
        .prepare(
          `DELETE FROM threads
            WHERE (answer IS NULL AND created_at < ?)
               OR (answer IS NOT NULL AND answered_at < ?)`,
        )
        .run(now - RETENTION.openThreadMs, now - RETENTION.answeredThreadMs).changes;
      return { statuses, threads };
    });
  }

  // --- internals ------------------------------------------------------------

  // IMMEDIATE takes the write lock up front, so the busy timeout applies and
  // two processes can't both read the same seq before bumping it. Nested
  // calls become savepoints inside the outer transaction.
  write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private nextSeq(): number {
    const row = this.db
      .prepare("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value")
      .get() as { value: number };
    return row.value;
  }

  private metaValue(key: string): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: number };
    return row.value;
  }
}
