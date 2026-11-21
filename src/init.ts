import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Settings, hookCommand, withHook, withoutHook } from "./settings.js";

export const SERVER_NAME = "phoneline";

export interface InitOptions {
  /** Directory holding ~/.claude/settings.json; defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string;
  /** Absolute node binary; defaults to the one running this. */
  nodePath?: string;
  /** Directory with cli.js and hook.js; defaults to this file's directory. */
  distDir?: string;
  /** Runs `claude <args>`. */
  claude?: (args: string[]) => { status: number | null; output: string; missing?: boolean };
  log?: (line: string) => void;
}

function runClaude(args: string[]) {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), missing };
}

function resolve(opts: InitOptions) {
  const distDir = opts.distDir ?? dirname(realpathSync(fileURLToPath(import.meta.url)));
  return {
    configDir: opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    nodePath: opts.nodePath ?? process.execPath,
    cliPath: join(distDir, "cli.js"),
    hookPath: join(distDir, "hook.js"),
    claude: opts.claude ?? runClaude,
    log: opts.log ?? ((line: string) => console.log(line)),
  };
}

/** Read settings.json; a missing file is empty settings. Throws if it isn't valid JSON. */
function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Settings;
}

/** Write via a temp file and rename, so a crash can't leave half a file. */
function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.phoneline-tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Before phoneline first edits settings.json, keep a copy of the original. */
function backUpOnce(path: string): string | undefined {
  const backup = `${path}.before-phoneline`;
  if (!existsSync(path) || existsSync(backup)) return undefined;
  copyFileSync(path, backup);
  return backup;
}

/**
 * Register the MCP server at user scope and add the unread hook to
 * settings.json. Safe to re-run: both entries are replaced, never duplicated.
 * Returns the process exit code.
 */
export function runInit(opts: InitOptions = {}): number {
  const { configDir, nodePath, cliPath, hookPath, claude, log } = resolve(opts);
  const settingsPath = join(configDir, "settings.json");

  for (const file of [cliPath, hookPath]) {
    if (!existsSync(file)) {
      log(`phoneline init: ${file} is missing. Build first (npm run build) or reinstall phoneline.`);
      return 1;
    }
  }

  // Read settings before changing anything, so a bad file stops us cleanly.
  let settings: Settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    log(`phoneline init: can't parse ${settingsPath} (${(err as Error).message}). Fix it and re-run; nothing was changed.`);
    return 1;
  }

  // Remove first so a re-run picks up new paths; "not found" is fine.
  const removed = claude(["mcp", "remove", "--scope", "user", SERVER_NAME]);
  if (removed.missing) {
    log("phoneline init: the `claude` command isn't on your PATH. Install Claude Code, then re-run.");
    return 1;
  }
  const added = claude(["mcp", "add", "--scope", "user", SERVER_NAME, "--", nodePath, cliPath, "serve"]);
  if (added.status !== 0) {
    log(`phoneline init: \`claude mcp add\` failed; nothing else was changed.\n${added.output}`);
    return 1;
  }

  const backup = backUpOnce(settingsPath);
  writeSettings(settingsPath, withHook(settings, hookCommand(nodePath, hookPath)));

  log(
    [
      "phoneline is set up for every repo:",
      `  MCP server  "${SERVER_NAME}" (user scope): ${nodePath} ${cliPath} serve`,
      `  Hook        UserPromptSubmit in ${settingsPath}`,
      ...(backup ? [`  Backup      ${backup}`] : []),
      "",
      "Restart any open Claude Code sessions to pick it up.",
      `This uses Node ${process.versions.node} at ${nodePath}. If you switch Node major versions, run \`phoneline init\` again.`,
      "Give two terminals on the same branch different names with PHONELINE_AGENT, or use a git worktree each.",
    ].join("\n"),
  );
  return 0;
}

/** Undo init: remove the MCP server and phoneline's hook. Databases are kept. */
export function runUninstall(opts: InitOptions = {}): number {
  const { configDir, claude, log } = resolve(opts);
  const settingsPath = join(configDir, "settings.json");

  let settings: Settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    log(`phoneline uninstall: can't parse ${settingsPath} (${(err as Error).message}). Nothing was changed.`);
    return 1;
  }

  const removedServer = claude(["mcp", "remove", "--scope", "user", SERVER_NAME]);
  if (removedServer.missing) {
    log("phoneline uninstall: the `claude` command isn't on your PATH, so the MCP server wasn't removed.");
  }
  const { settings: next, removed } = withoutHook(settings);
  if (removed > 0) writeSettings(settingsPath, next);

  log(
    [
      `MCP server: ${removedServer.status === 0 ? "removed" : "not registered"}.`,
      `Hook: ${removed > 0 ? `removed from ${settingsPath}` : "not present"}.`,
      "Your data in ~/.phoneline was kept; delete that folder to remove it.",
    ].join("\n"),
  );
  return 0;
}
