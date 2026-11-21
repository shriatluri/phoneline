// Editing ~/.claude/settings.json, which holds the user's own settings
// alongside ours. Only phoneline's hook entry is ever added or removed;
// everything else is passed through untouched.

export const HOOK_EVENT = "UserPromptSubmit";
export const HOOK_TIMEOUT_S = 5;

interface HookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

export type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[] | unknown> };

/** The hook command: absolute node and entry paths, quoted for spaces. */
export function hookCommand(nodePath: string, hookPath: string): string {
  return `"${nodePath}" "${hookPath}"`;
}

/**
 * Whether a hook entry is one phoneline wrote: any command running this
 * install's `hookPath`, or a phoneline hook.js from another install location.
 */
export function isPhonelineHook(entry: HookEntry, hookPath?: string): boolean {
  if (typeof entry.command !== "string") return false;
  if (hookPath && entry.command.includes(hookPath)) return true;
  return /phoneline/.test(entry.command) && /hook\.js/.test(entry.command);
}

/** Remove phoneline's hook entries, dropping any group they leave empty. */
export function withoutHook(settings: Settings, hookPath?: string): { settings: Settings; removed: number } {
  const groups = settings.hooks?.[HOOK_EVENT];
  if (!Array.isArray(groups)) return { settings, removed: 0 };

  let removed = 0;
  const kept: HookGroup[] = [];
  for (const group of groups as HookGroup[]) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((h) => !isPhonelineHook(h, hookPath));
    removed += group.hooks.length - hooks.length;
    if (hooks.length > 0 || group.hooks.length === 0) kept.push({ ...group, hooks });
  }

  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks[HOOK_EVENT] = kept;
  else delete hooks[HOOK_EVENT];
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

/** Add phoneline's hook, replacing any earlier one, so re-running never duplicates it. */
export function withHook(settings: Settings, command: string, hookPath?: string): Settings {
  const base = withoutHook(settings, hookPath).settings;
  const hooks = { ...base.hooks };
  const groups = Array.isArray(hooks[HOOK_EVENT]) ? (hooks[HOOK_EVENT] as HookGroup[]) : [];
  hooks[HOOK_EVENT] = [...groups, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }];
  return { ...base, hooks };
}
