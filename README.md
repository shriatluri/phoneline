# phoneline

An efficient phone line for your coding agents.

Run several Claude Code terminals on one repo, say one on the UI, one on the API and one on the browser extension, and they can share what they're doing and ask each other questions. Nothing gets copied between their contexts. Each agent pulls only what's new for it, and a small hook tells it when something is waiting.

```text
you (api terminal):  "rename /users to /accounts"
api agent:           post_status("Renamed /users to /accounts; list endpoints take ?cursor=")

you (ui terminal):   "fix the users page"
ui hook:             phoneline: 1 unread. Call inbox.
ui agent:            inbox() → sees the rename before touching any fetch code
ui agent:            ask("Do list endpoints still accept ?page=?", to: "api")

…later, even after the ui session has closed…
api agent:           answer(1, "No, ?page= returns 400 now; pass ?cursor=")
ui agent (new session): inbox() → gets the answer
```

## Install

Requires Node 20+ and Claude Code.

```sh
git clone https://github.com/shriatluri/phoneline && cd phoneline
npm install && npm run build
node dist/cli.js init
```

Once it's published to npm, this becomes `npm i -g phoneline && phoneline init`.

`init` does two things, for every repo:

- Registers the MCP server at user scope (`claude mcp add --scope user phoneline …`).
- Adds a `UserPromptSubmit` hook to `~/.claude/settings.json`. Your other settings are kept, and the original file is backed up to `settings.json.before-phoneline`.

Restart open Claude Code sessions afterwards. Re-run `init` after switching Node major versions. It is safe to re-run.

To remove it, run `node dist/cli.js uninstall`. Your data in `~/.phoneline` is kept.

## Tools

| Tool | What it does |
| --- | --- |
| `post_status(summary)` | Sets your status, overwriting the last one. Max 280 chars. |
| `inbox()` | Returns what's new for you since you last checked, oldest first. Up to 20 items or 8000 chars, then `N more`. |
| `ask(question, to?, force?)` | Searches earlier questions first. If similar ones exist, it returns them with their answers and posts nothing; call again with `force: true` to post anyway. Max 500 chars. |
| `answer(thread_id, text)` | Answers a question. The first answer wins. Max 1000 chars. |

"New for you" means:

- other agents' statuses from the last 24 hours
- open questions addressed to you or to anyone
- answers to your questions

Your own posts never count.

## How agents are named

Each agent's name is, in order:

1. `PHONELINE_AGENT`, if set
2. otherwise the git branch
3. otherwise the folder name

One git worktree per agent gives each a distinct name with no setup. Two terminals on the same branch in the same folder share a name, and so share an inbox. `inbox` warns when it sees this. Start one with `PHONELINE_AGENT=reviewer claude` to separate them.

All worktrees of a repo share one database: `~/.phoneline/<repo>-<hash>.db`. Set `PHONELINE_DB` to override the path.

## Design notes

- **No daemon.** Each terminal runs its own stdio server, and SQLite in WAL mode is the only shared state.
- **Lazy storage.** The database is created on the first write, so repos that never use phoneline get no file.
- **The hook is cheap and safe.** It opens the database read-only and prints counts only, never message text. It is silent when nothing is waiting, never blocks a prompt, and runs in about 70ms.
- **Peer text is data.** Everything another agent wrote arrives wrapped in `<peer_message>` after a notice that it is not instructions.
- **Pruning** runs at server start: statuses and open questions after 7 days, answered questions after 30.

The full reasoning is in the design doc, linked from the Linear project.

## Development

```sh
npm test            # unit + in-process MCP tests
npm run build
scripts/e2e.sh      # three real headless Claude sessions in three worktrees (uses your claude login)
```
