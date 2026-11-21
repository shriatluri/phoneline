import type Database from "better-sqlite3";

// What counts as unread lives here, and only here. The inbox tool lists these
// items and the hook counts them, so the hook's "2 unread" always matches what
// inbox returns. This module imports only better-sqlite3 types, so the hook can
// load it without the MCP SDK.

/** Statuses older than this are not worth interrupting anyone for. */
export const STATUS_FRESH_MS = 24 * 60 * 60 * 1000;

export type UnreadKind = "status" | "question" | "answer";

export interface UnreadItem {
  kind: UnreadKind;
  seq: number;
  /** Who wrote it: the status owner, the asker, or the answerer. */
  from: string;
  /** When it was written: status update, question, or answer time. */
  at: number;
  thread: number | null;
  /** For questions: who it is addressed to; null means anyone. */
  to: string | null;
  question: string | null;
  /** The status summary or the answer text; null for a question. */
  text: string | null;
}

// For agent @me with cursor @cursor, unread is seq > cursor and one of:
//   - a status from another agent, updated since @fresh
//   - an open question from another agent, addressed to me or to anyone
//   - an answer by another agent to a question I asked
// My own posts never count, and neither do questions addressed to others or
// answers to other agents' questions.
const UNREAD_SQL = `
  SELECT 'status' AS kind, seq, agent AS "from", updated_at AS at,
         NULL AS thread, NULL AS "to", NULL AS question, summary AS text
    FROM statuses
   WHERE seq > @cursor AND agent != @me AND updated_at >= @fresh
  UNION ALL
  SELECT 'question', seq, from_agent, created_at, id, to_agent, question, NULL
    FROM threads
   WHERE seq > @cursor AND from_agent != @me AND answer IS NULL
     AND (to_agent IS NULL OR to_agent = @me)
  UNION ALL
  SELECT 'answer', seq, answered_by, answered_at, id, to_agent, question, answer
    FROM threads
   WHERE seq > @cursor AND from_agent = @me AND answer IS NOT NULL AND answered_by != @me
`;

function params(me: string, cursor: number, now: number) {
  return { me, cursor, fresh: now - STATUS_FRESH_MS };
}

/** Unread items for `me` after `cursor`, oldest first. */
export function unreadItems(db: Database.Database, me: string, cursor: number, now = Date.now()): UnreadItem[] {
  return db.prepare(`${UNREAD_SQL} ORDER BY seq`).all(params(me, cursor, now)) as UnreadItem[];
}

export interface UnreadCounts {
  total: number;
  /** Open questions addressed to `me` by name. */
  questionsForMe: number;
}

/** The same items as unreadItems, counted in SQL. */
export function countUnread(db: Database.Database, me: string, cursor: number, now = Date.now()): UnreadCounts {
  const row = db
    .prepare(
      `SELECT count(*) AS total,
              coalesce(sum(kind = 'question' AND "to" = @me), 0) AS questionsForMe
         FROM (${UNREAD_SQL})`,
    )
    .get(params(me, cursor, now)) as UnreadCounts;
  return row;
}

/** Last seq this agent has read; 0 if it has never read. */
export function readCursor(db: Database.Database, me: string): number {
  const row = db.prepare("SELECT last_seq FROM read_cursors WHERE agent = ?").get(me) as
    | { last_seq: number }
    | undefined;
  return row?.last_seq ?? 0;
}
