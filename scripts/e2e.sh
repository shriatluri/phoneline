#!/usr/bin/env bash
# End-to-end check with real, headless Claude Code sessions (SHRI-29).
#
# Three agents work in three git worktrees of one throwaway repo: ui, api and
# extension, named by their branches. Each step is a fresh `claude -p`
# session using the built server and hook, loaded with --mcp-config and
# --settings, so your own Claude config is never changed.
#
# Needs: `npm run build`, a logged-in `claude`. Costs a few cents of usage.
# Usage: scripts/e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
WORK="$(mktemp -d -t phoneline-e2e)"
REPO="$WORK/app"

git init -q -b main "$REPO"
git -C "$REPO" -c user.email=e2e@phoneline -c user.name=e2e commit -q --allow-empty -m init
for agent in ui api extension; do git -C "$REPO" worktree add -q "$WORK/$agent" -b "$agent"; done

DB="$(cd "$REPO" && env -u CLAUDE_PROJECT_DIR -u PHONELINE_DB "$NODE" --input-type=module -e "import { defaultDbPath } from '$ROOT/dist/store.js'; console.log(defaultDbPath())")"
cleanup() { rm -f "$DB" "$DB-wal" "$DB-shm"; rmdir "$(dirname "$DB")" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/mcp.json" <<JSON
{"mcpServers":{"phoneline":{"command":"$NODE","args":["$ROOT/dist/cli.js","serve"]}}}
JSON
cat > "$WORK/settings.json" <<JSON
{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"\"$NODE\" \"$ROOT/dist/hook.js\"","timeout":5}]}]}}
JSON

step() { # step <agent> <prompt>
  echo
  echo "━━━ [$1] $2"
  (cd "$WORK/$1" && env -u PHONELINE_AGENT -u PHONELINE_DB -u CLAUDE_PROJECT_DIR claude -p "$2" \
    --mcp-config "$WORK/mcp.json" --strict-mcp-config --settings "$WORK/settings.json" \
    --allowedTools mcp__phoneline__post_status mcp__phoneline__inbox mcp__phoneline__ask mcp__phoneline__answer \
    < /dev/null 2>&1) | sed 's/^/    /'
}

step api "Use phoneline to post your status: 'Renamed /users to /accounts. List endpoints now take ?cursor= instead of ?page='. Reply with the tool result only."
step ui "Hi. Is anything waiting for me? Then use phoneline to ask the api agent: 'Do list endpoints still accept ?page= during the migration?' Reply in two lines: what was waiting, and the ask result."
step extension "Use phoneline to ask anyone: 'Can list endpoints still be called with page numbers while cursors roll out?' If it finds earlier questions instead of posting, say which thread and don't force. Reply in one line."
step api "Check your phoneline inbox. Answer any question for you with phoneline's answer tool: 'No. ?page= returns 400 now; pass ?cursor= from the previous response.' Reply in one line."
step ui "Anything new for me? Reply in one line with what you found."
step extension "Check your phoneline inbox and reply in one line per item."
step ui "Call phoneline's inbox once more and paste its raw output."

echo
echo "━━━ Checks (from the DB)"
"$NODE" --input-type=module - "$ROOT" "$DB" <<'JS'
import { createRequire } from "node:module";
const Database = createRequire(`${process.argv[2]}/package.json`)("better-sqlite3");
const db = new Database(process.argv[3], { readonly: true });
const rows = (sql) => db.prepare(sql).all();
const threads = rows("SELECT id, from_agent, to_agent, answered_by FROM threads ORDER BY id");
const cursors = Object.fromEntries(rows("SELECT agent, last_seq FROM read_cursors").map((r) => [r.agent, r.last_seq]));
const seq = rows("SELECT value FROM meta WHERE key = 'seq'")[0].value;
const checks = [
  ["one DB shared by all three worktrees", rows("SELECT name FROM agents").length === 3],
  ["agents named by branch", rows("SELECT name FROM agents ORDER BY name").map((r) => r.name).join(",") === "api,extension,ui"],
  ["api posted a status", rows("SELECT 1 FROM statuses WHERE agent = 'api'").length === 1],
  ["ui's question to api was answered by api", threads.some((t) => t.from_agent === "ui" && t.to_agent === "api" && t.answered_by === "api")],
  ["extension's paraphrase did not create a duplicate", threads.length === 1],
  ["ui has read everything (only-new inbox)", cursors.ui === seq],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(`  threads: ${JSON.stringify(threads)}`);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
JS
