/**
 * How Claude Code runs one command hook and reads what it did, per the hooks reference
 * (code.claude.com/docs/en/hooks, v2.1.285; checked against a real claude 2.1.280):
 * - exec form: `command` spawned with `args`, the event's JSON on stdin;
 * - `timeout` seconds, then the hook is cancelled and "renders no decision";
 * - stdout is JSON when it starts with `{` and ends with `}` (surrounding whitespace
 *   ignored), otherwise plain text; JSON that does not parse is a non-blocking error;
 * - exit 2 blocks (the event's own meaning); any other code without valid JSON is a
 *   non-blocking error: the action proceeds.
 * Used by the fake runner (fake-claude.ts); it knows nothing about jevdict.
 */
import { join } from "node:path";

/** A command hook in exec form, as a settings file registers it. */
export interface HookCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** One run of a hook: what came back, and how Claude Code reads it. */
export interface HookRun {
  /** Null when the hook was cancelled at its timeout. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The JSON output, when stdout is a JSON object that parses. */
  readonly json: Record<string, unknown> | null;
  /** Why the run is a non-blocking error ("hook error" notice), or null. */
  readonly hookError: string | null;
  readonly ms: number;
}

/** How to spawn: environment, cwd, timeout, and whether the parent looks like `claude -p`. */
export interface SpawnOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutS: number;
  readonly headless: boolean;
}

const PARENT = join(import.meta.dir, "fake-claude-parent.ts");

/** Stdout as Claude Code reads it: JSON object, plain text, or a parse failure. */
export function readStdout(stdout: string): {
  json: Record<string, unknown> | null;
  error: string | null;
} {
  const t = stdout.trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return { json: null, error: null };
  try {
    const value: unknown = JSON.parse(t);
    return { json: value as Record<string, unknown>, error: null };
  } catch (cause) {
    return { json: null, error: `invalid JSON output: ${(cause as Error).message}` };
  }
}

function argvOf(hook: HookCommand, headless: boolean): string[] {
  const direct = [hook.command, ...hook.args];
  return headless ? [process.execPath, PARENT, "-p", "--", ...direct] : direct;
}

/** Spawns `hook` once with `payload` on stdin and reads its outcome. */
export async function spawnHook(
  hook: HookCommand,
  payload: string,
  o: SpawnOptions,
): Promise<HookRun> {
  const started = performance.now();
  let proc: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    proc = Bun.spawn(argvOf(hook, o.headless), {
      cwd: o.cwd,
      env: { ...o.env },
      stdin: new Blob([payload]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    // "A hook that can't start lands in the same non-blocking bucket" (hooks#other-exit-codes).
    const hookError = `Failed with non-blocking status code: ${(cause as Error).message}`;
    return { exitCode: 127, stdout: "", stderr: "", json: null, hookError, ms: 0 };
  }
  let cancelled = false;
  const timer = setTimeout(() => {
    cancelled = true;
    proc.kill("SIGTERM");
  }, o.timeoutS * 1_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const ms = performance.now() - started;
  if (cancelled)
    return { exitCode: null, stdout: "", stderr, json: null, hookError: "timeout", ms };
  const { json, error } = readStdout(stdout);
  const nonBlocking = code !== 0 && code !== 2 && json === null;
  const hookError = error ?? (nonBlocking ? `Failed with non-blocking status code: ${code}` : null);
  return { exitCode: code, stdout, stderr, json, hookError, ms };
}
