import { type HookPort, processPort, runHookProcess } from "@jevdict/adapter-claude-code/process";
import type { Io } from "../io.ts";

/**
 * `jevdict hook --harness claude-code [--socket path]`: the Claude Code command hook run from
 * the full CLI. It shares the adapter's runtime with the lean `dist/jevdict-hook` (which is
 * what gets registered: it starts faster and cannot fail to load the CLI's other modules):
 * reads the hook payload on stdin, writes Claude Code's output and exits 0 or 2 itself,
 * failing closed. `--harness pi` is refused (Pi runs an extension, not a hook).
 */
export async function runHookCommand(
  argv: readonly string[],
  _io: Io,
  port: HookPort = processPort(),
): Promise<number> {
  return runHookProcess(argv, ["hook"], port);
}
