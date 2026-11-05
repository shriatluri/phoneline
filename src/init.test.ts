import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InitOptions, runInit, runUninstall } from "./init.js";

describe("init", () => {
  let dir: string;
  let configDir: string;
  let distDir: string;
  let calls: string[][];
  let lines: string[];
  let registered: boolean;
  const settingsPath = () => join(configDir, "settings.json");
  const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));

  const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
    configDir,
    distDir,
    nodePath: "/opt/node/bin/node",
    log: (l) => lines.push(l),
    claude: (args) => {
      calls.push(args);
      if (args[1] === "add") registered = true;
      if (args[1] === "remove") {
        const was = registered;
        registered = false;
        return { status: was ? 0 : 1, output: was ? "Removed" : "No MCP server found" };
      }
      return { status: 0, output: "Added" };
    },
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phoneline-init-"));
    configDir = join(dir, ".claude");
    distDir = join(dir, "phoneline", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "cli.js"), "");
    writeFileSync(join(distDir, "hook.js"), "");
    calls = [];
    lines = [];
    registered = false;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers the server with absolute paths and adds the hook", () => {
    expect(runInit(opts())).toBe(0);
    expect(calls).toEqual([
      ["mcp", "remove", "--scope", "user", "phoneline"],
      ["mcp", "add", "--scope", "user", "phoneline", "--", "/opt/node/bin/node", join(distDir, "cli.js"), "serve"],
    ]);
    expect(readSettings()).toEqual({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `"/opt/node/bin/node" "${join(distDir, "hook.js")}"`, timeout: 5 }] },
        ],
      },
    });
    expect(lines.join("\n")).toContain("If you switch Node major versions, run `phoneline init` again.");
  });

  it("is idempotent and keeps the user's settings, backing up the original once", () => {
    mkdirSync(configDir);
    const original = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(settingsPath(), JSON.stringify(original));

    expect(runInit(opts())).toBe(0);
    expect(runInit(opts({ nodePath: "/new/node" }))).toBe(0);

    const s = readSettings();
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop).toEqual(original.hooks.Stop);
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('"/new/node"');
    expect(JSON.parse(readFileSync(`${settingsPath()}.before-phoneline`, "utf8"))).toEqual(original);
    expect(calls.filter((c) => c[1] === "add")).toHaveLength(2);
    expect(registered).toBe(true);
  });

  it("changes nothing when settings.json is not valid JSON", () => {
    mkdirSync(configDir);
    writeFileSync(settingsPath(), "{ broken");
    expect(runInit(opts())).toBe(1);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ broken");
    expect(calls).toEqual([]);
    expect(lines[0]).toContain("can't parse");
  });

  it("stops before touching settings if claude is missing or mcp add fails", () => {
    expect(runInit(opts({ claude: () => ({ status: null, output: "", missing: true }) }))).toBe(1);
    expect(lines[0]).toContain("isn't on your PATH");
    expect(runInit(opts({ claude: (a) => ({ status: a[1] === "add" ? 1 : 0, output: "boom" }) }))).toBe(1);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("refuses to register a missing build", () => {
    rmSync(join(distDir, "hook.js"));
    expect(runInit(opts())).toBe(1);
    expect(lines[0]).toContain("npm run build");
    expect(calls).toEqual([]);
  });

  it("uninstalls cleanly, keeping other settings", () => {
    mkdirSync(configDir);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    runInit(opts());
    lines = [];
    expect(runUninstall(opts())).toBe(0);
    expect(readSettings()).toEqual({ theme: "dark" });
    expect(registered).toBe(false);
    expect(lines.join("\n")).toContain("MCP server: removed.");

    lines = [];
    expect(runUninstall(opts())).toBe(0); // second run is a no-op
    expect(lines.join("\n")).toContain("MCP server: not registered.\nHook: not present.");
  });
});
