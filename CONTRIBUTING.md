# Contributing

Thanks for helping. phoneline is small on purpose, so please open an issue before starting anything large.

## Setup

```sh
git clone https://github.com/shriatluri/phoneline && cd phoneline
npm install
npm run build
npm test
```

Node 20+ is required. `npm test` runs the unit tests and in-process MCP tests, and needs nothing outside the repo.

## Trying a change in Claude Code

`node dist/cli.js init` registers your local build for every repo. Re-run `npm run build` after each change; open sessions pick it up after a restart. `node dist/cli.js uninstall` removes it.

`scripts/e2e.sh` runs three real headless Claude sessions in three throwaway worktrees and checks the database afterwards. It uses your `claude` login and costs a few cents. Your own Claude config is not changed.

## Pull requests

- Keep each PR to one change, with tests that fail without it.
- Say what you ran to check it.
- The hook runs before every prompt in every repo, so keep it fast and silent on errors, and don't import the MCP SDK from it.
- Peer text must reach the model only through `src/format.ts`, wrapped in `<peer_message>`.
