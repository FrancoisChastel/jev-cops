/**
 * How the tests register the hook: the source entry run by this Bun (as `cops install`
 * would register the compiled binary), and the settings block for every event.
 */
import { join } from "node:path";
import { HOOK_TIMEOUTS_S } from "../src/hook-entries.ts";
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

/** A settings object registering the hook on every event, in exec form (PLAN-M1 §4.3). */
export function jevCopsSettings(socket: string, binary?: string): Record<string, unknown> {
  const hook = hookCommand(socket, binary);
  const entry = (event: string) => [
    {
      hooks: [
        {
          type: "command",
          command: hook.command,
          args: hook.args,
          timeout: HOOK_TIMEOUTS_S[event as keyof typeof HOOK_TIMEOUTS_S],
        },
      ],
    },
  ];
  return { hooks: Object.fromEntries(Object.keys(HOOK_TIMEOUTS_S).map((e) => [e, entry(e)])) };
}
