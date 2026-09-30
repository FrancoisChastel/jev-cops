/**
 * One bounded scanner process (PLAN-SETUP §4.1 `run.ts`): exec form (never a shell), an
 * absolute binary, an environment built from scratch, a hard deadline, a stdout cap and the
 * last 2 KB of stderr. The child starts its own process group (`setsid`), and the whole group
 * is SIGKILLed at the deadline, on abort, on overflow and after a normal exit, so nothing a
 * scanner spawns outlives its scan. Never throws.
 */
import { isAbsolute } from "node:path";
import type { Env } from "./types.ts";

/** Largest stdout read from a scanner; more is an error, never a truncated parse. */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** How much of the end of stderr is kept for the audit line. */
export const STDERR_TAIL_BYTES = 2048;
/** How long stderr may take to close once the group is dead. */
const STDERR_GRACE_MS = 100;

/** One process to run. */
export interface RunRequest {
  /** argv[0] must be absolute; nothing is looked up here. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The whole environment: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Default {@link MAX_STDOUT_BYTES}. */
  readonly maxStdoutBytes?: number;
}

/** How it ended. Only `exit` carries stdout; every other kind is an error for the caller. */
export type RunOutcome =
  | {
      readonly kind: "exit";
      readonly code: number;
      readonly stdout: string;
      readonly stderrTail: string;
    }
  | { readonly kind: "timeout" | "overflow" | "aborted"; readonly stderrTail: string }
  | { readonly kind: "spawn-error"; readonly error: string };

/** Runs one scanner process; injected in tests that only record argv and env. */
export type Spawn = (r: RunRequest) => Promise<RunOutcome>;

/** `PATH` with every relative or empty entry dropped (`.` would resolve in the scan dir). */
export function absolutePath(pathEnv: string): string {
  return pathEnv
    .split(":")
    .filter((d) => isAbsolute(d))
    .join(":");
}

const BASE_VARS = ["HOME", "LANG", "TMPDIR"] as const;

/**
 * The scanner's whole environment, built from the daemon's own `source` (never the agent's):
 * `PATH` (absolute entries only), `HOME`, `LANG`, `TMPDIR`, then each variable of `pass`
 * that is set, then `extra`. Everything else (keys, `GIT_*`, proxies) is left out.
 */
export function scanEnv(
  source: Env,
  pass: readonly string[] = [],
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = { PATH: absolutePath(source.PATH ?? "") };
  for (const name of [...BASE_VARS, ...pass]) {
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    if (value !== undefined && value !== "") env[name] = value;
  }
  return { ...env, ...extra };
}

/** Reads a stream to its end, up to `maxBytes`; past that it stops and reports overflow. */
function capped(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  const done = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        size += value.byteLength;
        if (size > maxBytes) {
          overflow = true;
          await reader.cancel().catch(() => undefined);
          return;
        }
        chunks.push(value);
      }
    } catch {
      // A read error ends the stream; what was read stands.
    }
  })();
  return {
    done,
    overflowed: () => overflow,
    text: () => new TextDecoder().decode(Buffer.concat(chunks)),
  };
}

/** Reads a stream to its end, keeping only its last `keep` bytes. */
function tail(stream: ReadableStream<Uint8Array>, keep: number) {
  let buf = Buffer.alloc(0);
  const done = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        buf = Buffer.concat([buf, value]);
        if (buf.byteLength > keep) buf = buf.subarray(buf.byteLength - keep);
      }
    } catch {
      // Same as stdout.
    }
  })();
  return { done, text: () => new TextDecoder().decode(buf) };
}

type Stop = "timeout" | "aborted";

/** Resolves at the deadline or on abort, whichever comes first; `clear` releases both. */
function stopOf(deadlineMs: number, signal: AbortSignal | undefined) {
  let clear = () => {};
  const promise = new Promise<Stop>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineMs));
    const onAbort = () => resolve("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
  });
  return { promise, clear: () => clear() };
}

function killGroup(proc: Bun.Subprocess): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

const NEVER = new Promise<never>(() => {});

async function supervise(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  r: RunRequest,
  stop: Promise<Stop>,
): Promise<RunOutcome> {
  const out = capped(proc.stdout, r.maxStdoutBytes ?? MAX_STDOUT_BYTES);
  const err = tail(proc.stderr, STDERR_TAIL_BYTES);
  const overflow = out.done.then(() => (out.overflowed() ? ("overflow" as const) : NEVER));
  const first = await Promise.race([proc.exited.then((code) => ({ code })), overflow, stop]);
  // Whatever happened, nothing the scanner started may keep running (or keep a pipe open).
  killGroup(proc);
  const stderrTail = async () => {
    await Promise.race([err.done, Bun.sleep(STDERR_GRACE_MS)]);
    return err.text();
  };
  if (typeof first === "string") return { kind: first, stderrTail: await stderrTail() };
  const drained = await Promise.race([out.done.then(() => "drained" as const), stop]);
  if (drained !== "drained") return { kind: drained, stderrTail: await stderrTail() };
  if (out.overflowed()) return { kind: "overflow", stderrTail: await stderrTail() };
  return { kind: "exit", code: first.code, stdout: out.text(), stderrTail: await stderrTail() };
}

/**
 * The real {@link Spawn}: `Bun.spawn` with `detached` (a new session and process group),
 * stdin closed, stdout capped, stderr tailed; the group is SIGKILLed when the call ends.
 */
export const runBounded: Spawn = async (r) => {
  const [bin] = r.argv;
  if (bin === undefined || !isAbsolute(bin)) {
    return { kind: "spawn-error", error: `not an absolute path: ${bin ?? "(empty argv)"}` };
  }
  if (r.signal?.aborted === true) return { kind: "aborted", stderrTail: "" };
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...r.argv], {
      cwd: r.cwd,
      env: { ...r.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (cause) {
    return { kind: "spawn-error", error: cause instanceof Error ? cause.message : String(cause) };
  }
  const stop = stopOf(r.deadlineMs, r.signal);
  try {
    return await supervise(proc, r, stop.promise);
  } finally {
    stop.clear();
    killGroup(proc);
  }
};
