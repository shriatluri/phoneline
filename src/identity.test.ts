import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentName, cleanName } from "./identity.js";

describe("agentName", () => {
  let dir: string;
  let prevAgent: string | undefined;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  const commit = () => git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "phoneline-id-")));
    prevAgent = process.env.PHONELINE_AGENT;
    delete process.env.PHONELINE_AGENT;
  });

  afterEach(() => {
    if (prevAgent === undefined) delete process.env.PHONELINE_AGENT;
    else process.env.PHONELINE_AGENT = prevAgent;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the branch, including an unborn one", () => {
    git("init", "-q", "-b", "feature/api");
    expect(agentName(dir)).toBe("feature/api"); // no commits yet
    commit();
    expect(agentName(dir)).toBe("feature/api");
  });

  it("follows a branch switch", () => {
    git("init", "-q", "-b", "main");
    commit();
    git("checkout", "-q", "-b", "ui");
    expect(agentName(dir)).toBe("ui");
  });

  it("falls back to the directory name on a detached HEAD or outside git", () => {
    expect(agentName(dir)).toMatch(/^phoneline-id-/);
    git("init", "-q", "-b", "main");
    commit();
    git("checkout", "-q", "--detach");
    expect(agentName(dir)).toMatch(/^phoneline-id-/);
  });

  it("lets PHONELINE_AGENT win", () => {
    git("init", "-q", "-b", "main");
    process.env.PHONELINE_AGENT = "  reviewer ";
    expect(agentName(dir)).toBe("reviewer");
  });
});

describe("cleanName", () => {
  it("limits names to safe characters and 64 chars", () => {
    expect(cleanName("my agent!")).toBe("my-agent-");
    expect(cleanName("x".repeat(100))).toHaveLength(64);
    expect(cleanName("!!!")).toBe("-");
    expect(cleanName("")).toBe("agent");
  });
});
