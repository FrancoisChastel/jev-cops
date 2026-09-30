/**
 * Stand-in `claude` for the live canary tests (never the real one): `--version` prints
 * `$FAKE_CLAUDE_VERSION (Claude Code)`; `-p <prompt> …` finds the `printf jev-cops-canary-…`
 * command in the prompt, runs the first exec-form PreToolUse command hook of the user
 * settings (`$CLAUDE_CONFIG_DIR` or `~/.claude`) on a `Bash` call of it, as Claude Code
 * would, and prints the documented `--output-format json` result with its `session_id`.
 * Its argv is appended to `$FAKE_CLAUDE_LOG` (one JSON line per run) when set.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
const args = process.argv.slice(2);

function firstHook(): { command: string; args: string[] } | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude");
  try {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Json;
    const groups = ((settings.hooks as Json | undefined)?.PreToolUse ?? []) as Json[];
    const handler = groups
      .flatMap((g) => (g.hooks ?? []) as Json[])
      .find((h) => h.type === "command");
    return handler === undefined
      ? null
      : { command: String(handler.command), args: handler.args as string[] };
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  if (process.env.FAKE_CLAUDE_LOG)
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(args)}\n`);
  if (args[0] === "--version") {
    process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.285"} (Claude Code)\n`);
    return 0;
  }
  if (process.env.FAKE_CLAUDE_GARBLE === "1") {
    process.stdout.write("not json\n");
    return 1;
  }
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const command = /printf \S+/.exec(prompt)?.[0] ?? "true";
  const sessionId = randomUUID();
  const hook = firstHook();
  let blocked = false;
  if (hook !== null) {
    const payload = {
      session_id: sessionId,
      cwd: process.cwd(),
      permission_mode: "dontAsk",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `toolu_${randomUUID().replaceAll("-", "")}`,
    };
    const proc = Bun.spawn([hook.command, ...hook.args], {
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    blocked = (await proc.exited) === 2;
  }
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    result: blocked ? "blocked" : command.slice(7),
    session_id: sessionId,
    total_cost_usd: 0,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

process.exit(await main());
