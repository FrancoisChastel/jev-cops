/**
 * How the tests register the hook: the source entry run by this Bun (as `jevdict install`
 * would register the compiled binary), and the settings block for every event.
 */
import { join } from "node:path";
import type { HookCommand } from "./hook-run.ts";

/** The hook's source entry. */
export const HOOK_SOURCE = join(import.meta.dir, "..", "src", "hook-main.ts");

/** The command hook for `socket`: the compiled `binary`, or `bun src/hook-main.ts`. */
export function hookCommand(socket: string, binary?: string): HookCommand {
  const flags = ["--harness", "claude-code", "--socket", socket];
  return binary === undefined
    ? { command: process.execPath, args: [HOOK_SOURCE, ...flags] }
    : { command: binary, args: flags };
}

const TIMEOUTS_S: Readonly<Record<string, number>> = {
  PreToolUse: 30,
  PostToolUse: 15,
  PostToolUseFailure: 15,
  UserPromptSubmit: 10,
  ConfigChange: 10,
  SessionStart: 10,
  SessionEnd: 10,
};

/** A settings object registering the hook on every event, in exec form (PLAN-M1 §4.3). */
export function jevdictSettings(socket: string, binary?: string): Record<string, unknown> {
  const hook = hookCommand(socket, binary);
  const entry = (event: string) => [
    {
      hooks: [
        { type: "command", command: hook.command, args: hook.args, timeout: TIMEOUTS_S[event] },
      ],
    },
  ];
  return { hooks: Object.fromEntries(Object.keys(TIMEOUTS_S).map((e) => [e, entry(e)])) };
}
