// The welcome screen: shown once after `npm install -g phoneline`, and when
// someone runs `phoneline` with no command in a terminal. No dependencies, so
// the postinstall script can load it before anything else is set up.

const REPO_URL = "https://github.com/shriatluri/phoneline";

export interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
}

const plain: Style = { bold: (s) => s, dim: (s) => s, accent: (s) => s };
const ansi: Style = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  accent: (s) => `\x1b[36m${s}\x1b[39m`,
};

/** Color only for a terminal, and never when NO_COLOR is set (https://no-color.org). */
export function styleFor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): Style {
  return isTTY && !env.NO_COLOR ? ansi : plain;
}

const TOOLS: [string, string][] = [
  ["post_status", "tell the other agents what you're working on"],
  ["inbox", "read what's new for you since you last checked"],
  ["ask", "ask a question; finds earlier answers before posting"],
  ["answer", "reply to a question; the first answer wins"],
];

export function welcome(version: string, s: Style = plain): string {
  const pad = Math.max(...TOOLS.map(([name]) => name.length)) + 3;
  return [
    "",
    `  ${s.bold("☎  phoneline")} ${s.dim(`v${version}`)}`,
    `     ${s.dim("A phone line for your coding agents.")}`,
    "",
    "  Thanks for installing! Here's the TL;DR:",
    "",
    "  • Parallel Claude Code agents on one repo share status and ask questions",
    "  • Each agent pulls only what's new for it. Nothing is copied between contexts",
    "  • Everything stays local, in SQLite. No daemon, no network calls",
    "",
    `  ${s.bold("Tools your agents get")}`,
    ...TOOLS.map(([name, what]) => `  • ${s.accent(name.padEnd(pad))}${what}`),
    "",
    `  ${s.bold("Example uses")}`,
    '  • api posts "Renamed /users to /accounts" → ui adapts before anything breaks',
    '  • ui asks api "Does ?page= still work?" → answer arrives even after ui closes',
    "  • extension asks the same thing → gets the earlier answer, no re-ask",
    "",
    `  ${s.bold("Get started")}`,
    `  1. ${s.accent("phoneline init")}${s.dim("   one-time setup, for every repo")}`,
    `  2. Give each agent its own worktree: ${s.accent("git worktree add ../app-api -b api")}`,
    "  3. Restart Claude Code. You'll see a hint whenever something is waiting",
    "",
    `  ${s.dim(`Docs: ${REPO_URL}`)}`,
    "",
  ].join("\n");
}

/**
 * With no command, a person at a terminal gets the welcome screen; anything
 * else (an MCP client piping stdio) gets the server, as before.
 */
export function defaultCommand(stdinIsTTY: boolean): string {
  return stdinIsTTY ? "welcome" : "serve";
}

/**
 * Whether the postinstall script should greet: a global install, outside CI,
 * on a system with a terminal device. Local installs (phoneline as a
 * dependency, or `npm install` in this repo) stay quiet.
 */
export function shouldGreetOnInstall(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return env.npm_config_global === "true" && !env.CI && platform !== "win32";
}
