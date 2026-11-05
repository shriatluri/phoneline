import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentName } from "./identity.js";
import { defaultDbPath } from "./store.js";
import { countUnread, readCursor } from "./unread.js";

// The UserPromptSubmit hook. It runs before every prompt in every repo, so it
// must be fast and must never get in the way:
//   - it imports better-sqlite3 and the shared unread predicate, not the MCP SDK
//   - it opens the DB read-only, and only if the file already exists
//   - it prints counts only, never peer text or agent names
//   - it always exits 0 and prints nothing on any error (exit 2 would block the prompt)

/** The one-line hint for `me`, or undefined when there is nothing unread. */
export function unreadHint(dbPath: string, me: string, now = Date.now()): string | undefined {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { total, questionsForMe } = countUnread(db, me, readCursor(db, me), now);
    if (total === 0) return undefined;
    const questions =
      questionsForMe > 0 ? ` (${questionsForMe} question${questionsForMe === 1 ? "" : "s"} for you)` : "";
    return `phoneline: ${total} unread${questions}. Call inbox.`;
  } finally {
    db.close();
  }
}

export function runHook(): void {
  try {
    const hint = unreadHint(defaultDbPath(), agentName());
    if (hint) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hint } }),
      );
    }
  } catch {
    // No DB yet, a locked file, anything: stay silent and let the prompt through.
  }
}

// Run only when executed as `node dist/hook.js`, not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook();
  process.exitCode = 0;
}
