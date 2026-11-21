import { describe, expect, it } from "vitest";
import { type Settings, hookCommand, isPhonelineHook, withHook, withoutHook } from "./settings.js";

const ours = hookCommand("/usr/local/bin/node", "/usr/local/lib/node_modules/phoneline/dist/hook.js");

describe("settings", () => {
  it("quotes paths", () => {
    expect(hookCommand("/a b/node", "/c/phoneline/dist/hook.js")).toBe('"/a b/node" "/c/phoneline/dist/hook.js"');
  });

  it("recognises phoneline hooks from any install path", () => {
    expect(isPhonelineHook({ command: ours })).toBe(true);
    expect(isPhonelineHook({ command: '"/n" "/Users/me/phoneline/dist/hook.js"' })).toBe(true);
    expect(isPhonelineHook({ command: "node my-hook.js" })).toBe(false);
    expect(isPhonelineHook({ type: "prompt" })).toBe(false);
  });

  it("adds the hook to empty settings", () => {
    expect(withHook({}, ours)).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: ours, timeout: 5 }] }] },
    });
  });

  it("keeps the user's own settings and hooks, and never duplicates ours", () => {
    const user: Settings = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "date" }] }],
      },
    };
    const once = withHook(user, ours);
    const twice = withHook(once, hookCommand("/new/node", "/new/phoneline/dist/hook.js"));

    expect(twice.model).toBe("opus");
    expect(twice.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(twice.hooks?.PreToolUse).toEqual(user.hooks?.PreToolUse);
    expect(twice.hooks?.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "date" }] },
      { hooks: [{ type: "command", command: '"/new/node" "/new/phoneline/dist/hook.js"', timeout: 5 }] },
    ]);
    expect(user.hooks?.UserPromptSubmit).toHaveLength(1); // input not mutated
  });

  it("removes only our entry from a shared group", () => {
    const shared: Settings = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "date" }, { type: "command", command: ours }] }] },
    };
    expect(withoutHook(shared)).toEqual({
      settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "date" }] }] } },
      removed: 1,
    });
  });

  it("removes the hooks key entirely when ours was the only hook", () => {
    expect(withoutHook(withHook({ theme: "dark" }, ours))).toEqual({ settings: { theme: "dark" }, removed: 1 });
    expect(withoutHook({ theme: "dark" })).toEqual({ settings: { theme: "dark" }, removed: 0 });
  });
});
