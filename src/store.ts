import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;

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
  last_seen_at  INTEGER NOT NULL
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
  resolved    INTEGER NOT NULL DEFAULT 0,
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
  resolved: number;
  seq: number;
}

/** Git repo root for `cwd`, or `cwd` itself when it is not inside a repo. */
export function repoRoot(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

/** e.g. "/Users/me/code/My App" -> "my-app-1a2b3c4d" */
export function repoKey(root: string): string {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

/** PHONELINE_DB wins; otherwise ~/.phoneline/<repo-key>.db */
export function defaultDbPath(cwd = process.cwd()): string {
  return process.env.PHONELINE_DB || join(homedir(), ".phoneline", `${repoKey(repoRoot(cwd))}.db`);
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

  /** Insert the agent, or bump last_seen_at if it already exists. */
  registerAgent(name: string, now = Date.now()): Agent {
    return this.db
      .prepare(
        `INSERT INTO agents (name, registered_at, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at
         RETURNING *`,
      )
      .get(name, now, now) as Agent;
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

  /** Records the answer and marks the thread resolved. Returns undefined if the id is unknown. */
  answerThread(id: number, answeredBy: string, answer: string, now = Date.now()): Thread | undefined {
    return this.write(() => {
      this.registerAgent(answeredBy, now);
      const seq = this.nextSeq();
      return this.db
        .prepare(
          `UPDATE threads SET answer = ?, answered_by = ?, answered_at = ?, resolved = 1, seq = ?
           WHERE id = ? RETURNING *`,
        )
        .get(answer, answeredBy, now, seq, id) as Thread | undefined;
    });
  }

  getThread(id: number): Thread | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
  }

  /** Threads created or answered after `sinceSeq`; `openOnly` keeps unresolved ones (for ask's dedupe). */
  getThreads({ sinceSeq = 0, openOnly = false } = {}): Thread[] {
    return this.db
      .prepare(`SELECT * FROM threads WHERE seq > ? ${openOnly ? "AND resolved = 0" : ""} ORDER BY seq`)
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

  // --- internals ------------------------------------------------------------

  // IMMEDIATE takes the write lock up front, so the busy timeout applies and
  // two processes can't both read the same seq before bumping it.
  private write<T>(fn: () => T): T {
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
