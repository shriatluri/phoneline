import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { projectDir } from "./store.js";

const MAX_NAME = 64;

/**
 * Who "me" is. The server and the hook each compute this on their own, on
 * every call, so they always agree (session IDs can't be used: the two sides
 * see different ones after `--continue`). Resolution order:
 *
 *   1. PHONELINE_AGENT, if set
 *   2. the current git branch
 *   3. on a detached HEAD or outside git, the directory's basename
 */
export function agentName(dir = projectDir()): string {
  const fromEnv = process.env.PHONELINE_AGENT?.trim();
  if (fromEnv) return cleanName(fromEnv);
  return cleanName(currentBranch(dir) ?? basename(dir));
}

/** Limit names to [A-Za-z0-9._/-] and 64 chars. */
export function cleanName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9._/-]+/g, "-").slice(0, MAX_NAME);
  return name || "agent";
}

// `symbolic-ref` also works on an unborn branch, where `rev-parse --abbrev-ref
// HEAD` fails. With -q it exits non-zero, silently, on a detached HEAD.
function currentBranch(dir: string): string | undefined {
  try {
    return (
      execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
