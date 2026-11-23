# phoneline

[![CI](https://github.com/shriatluri/phoneline/actions/workflows/ci.yml/badge.svg)](https://github.com/shriatluri/phoneline/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/phoneline.svg)](https://www.npmjs.com/package/phoneline)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

**A phone line for your coding agents.**

Run several Claude Code terminals on one repo, say one on the UI, one on the API and one on the browser extension, and they can tell each other what they're doing and ask each other questions. Nothing is copied between their contexts. Each agent pulls only what's new for it, and a small hook tells it when something is waiting.

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

## Why

Parallel agents on one codebase step on each other. One changes an interface, and the others keep coding against the old one until something breaks. Pasting updates between terminals by hand doesn't scale, and sharing whole transcripts burns context.

phoneline gives each agent four small tools and a shared, local inbox. Agents post one-line statuses, ask questions and get answers later, and read only what's new for them.

## Quick start

Requires Node 20+ and [Claude Code](https://claude.com/claude-code).

```sh
npm install -g phoneline
phoneline init
```

Install it globally rather than running it with `npx`: `init` registers the installed files by path, and the `npx` cache can be cleared. To run from source instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

Then restart any open Claude Code sessions. Give each agent its own git worktree, or its own `PHONELINE_AGENT` name, and they're connected.

`init` sets phoneline up once, for every repo:

- It registers the MCP server at user scope (`claude mcp add --scope user phoneline …`).
- It adds a `UserPromptSubmit` hook to `~/.claude/settings.json`. Your other settings are kept, and the original file is backed up to `settings.json.before-phoneline`. A symlinked `settings.json` stays a symlink.

It is safe to re-run. Re-run it after switching Node major versions, since the server uses a native SQLite module.

To remove phoneline, run `phoneline uninstall`, then `npm uninstall -g phoneline`. Your data in `~/.phoneline` is kept.

## Tools

| Tool | What it does |
| --- | --- |
| `post_status(summary)` | Sets your status, replacing the last one. Max 280 chars. |
| `inbox()` | Returns what's new for you since you last checked, oldest first, and marks it read. Up to 20 items or 8000 chars, then `N more`. |
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

One git worktree per agent gives each a distinct name with no setup:

```sh
git worktree add ../app-api -b api
git worktree add ../app-ui -b ui
```

Two terminals on the same branch in the same folder share a name, and so share an inbox. `inbox` warns when it sees this. Start one with `PHONELINE_AGENT=reviewer claude` to separate them.

`ask(..., to: "api")` notes when no agent named `api` has used phoneline yet, and lists the agents that have, so a typo doesn't go unnoticed.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PHONELINE_AGENT` | git branch, then folder name | This agent's name |
| `PHONELINE_DB` | `~/.phoneline/<repo>-<hash>.db` | Database path |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where `init` writes `settings.json` |

All worktrees of a repo share one database, keyed on the repo's common `.git` directory.

## How it works

```text
 terminal: ui              terminal: api            terminal: extension
 Claude Code               Claude Code              Claude Code
   │  ▲ hook: "1 unread"     │  ▲                     │  ▲
   ▼  │                      ▼  │                     ▼  │
 phoneline (stdio)         phoneline (stdio)        phoneline (stdio)
   └───────────────┬─────────┴──────────────┬─────────┘
                   ▼                        ▼
           ~/.phoneline/<repo>-<hash>.db  (SQLite, WAL)
```

- **No daemon.** Each terminal runs its own stdio server, and SQLite in WAL mode is the only shared state.
- **Only what's new.** Every write bumps one counter, and each agent keeps a read cursor, so `inbox` is a single `seq > cursor` query.
- **Lazy storage.** The database is created on the first write, so repos that never use phoneline get no file.
- **The hook is cheap and safe.** It opens the database read-only and prints counts only, never message text. It is silent when nothing is waiting, never blocks a prompt, and takes about 70ms.
- **Duplicate questions are caught.** `ask` searches earlier questions with SQLite FTS5 and shows likely matches before posting.
- **Pruning** runs at server start. Statuses and open questions go after 7 days, answered questions after 30.

## Security

phoneline itself makes no network calls. Everything it stores stays on your machine, in `~/.phoneline`.

Agents read each other's text, so one agent could try to instruct another. Peer text always arrives wrapped in `<peer_message>`, after a notice that it is data, not instructions, and the tool descriptions say the same. This lowers the risk but can't remove it, so treat peers the way you'd treat any text an agent reads.

## Development

```sh
npm test            # unit + in-process MCP tests
npm run build
scripts/e2e.sh      # three real headless Claude sessions in three worktrees (uses your claude login)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
