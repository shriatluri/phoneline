import { describe, expect, it } from "vitest";
import { defaultCommand, shouldGreetOnInstall, styleFor, welcome } from "./welcome.js";

describe("welcome", () => {
  const text = welcome("1.2.3");

  it("introduces phoneline and lists all four tools", () => {
    expect(text).toContain("☎  phoneline v1.2.3");
    expect(text).toContain("A phone line for your coding agents.");
    for (const tool of ["post_status", "inbox", "ask", "answer"]) expect(text).toMatch(new RegExp(`• ${tool} `));
    expect(text).toContain("phoneline init");
  });

  it("fits an 80-column terminal", () => {
    const wide = text.split("\n").filter((line) => [...line].length > 80);
    expect(wide).toEqual([]);
  });

  it("colors only a terminal without NO_COLOR", () => {
    expect(text).not.toContain("\x1b[");
    expect(welcome("1.2.3", styleFor(true, {}))).toContain("\x1b[");
    expect(welcome("1.2.3", styleFor(true, { NO_COLOR: "1" }))).toBe(text);
    expect(welcome("1.2.3", styleFor(false, {}))).toBe(text);
  });
});

describe("defaultCommand", () => {
  it("welcomes a person at a terminal and serves an MCP client", () => {
    expect(defaultCommand(true)).toBe("welcome");
    expect(defaultCommand(false)).toBe("serve");
  });
});

describe("shouldGreetOnInstall", () => {
  it("greets only global installs, outside CI, off Windows", () => {
    expect(shouldGreetOnInstall({ npm_config_global: "true" }, "darwin")).toBe(true);
    expect(shouldGreetOnInstall({ npm_config_global: "true" }, "linux")).toBe(true);
    expect(shouldGreetOnInstall({}, "darwin")).toBe(false);
    expect(shouldGreetOnInstall({ npm_config_global: "true", CI: "true" }, "linux")).toBe(false);
    expect(shouldGreetOnInstall({ npm_config_global: "true" }, "win32")).toBe(false);
  });
});
