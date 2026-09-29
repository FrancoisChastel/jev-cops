import { isAbsolute } from "node:path";

/**
 * Running git on a directory the agent controls. Every call uses argv arrays (never a
 * shell string), an absolute git path, a scrubbed environment and flags that switch off
 * each place a repository's own config could run a program: fsmonitor, hooks, pager,
 * transports (ssh, `ext::`, remote helpers) and partial-clone lazy fetches. Callers only
 * run commands that never read worktree file contents, so filter drivers (`clean`,
 * `process`), which no flag can switch off by name, never run either (see git-derive.ts).
 */

/** What one git call produced. */
export interface GitOutput {
  /** Exit code; -1 when git could not start or was killed. */
  readonly code: number;
  /** Standard output, cut at the byte bound. */
  readonly stdout: string;
  /** True when stdout was cut (the caller must not trust a partial answer). */
  readonly truncated: boolean;
}

/** Runs `git <args>` in `cwd`; aborting `signal` kills it. Injected in tests. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<GitOutput>;

/** Largest stdout read from one call (a 20 000-file `ls-files --debug` fits). */
export const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Flags before every subcommand. Command-line config outranks the repository's own, so
 * `.git/config` cannot turn fsmonitor or a hooks path back on. `core.fsmonitor=` (empty)
 * is false: no hook command and no fsmonitor daemon.
 */
export const GIT_GUARD_ARGS: readonly string[] = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
]);

/** `PATH` with every relative entry dropped (`.` in PATH would resolve in the agent's cwd). */
export function absolutePath(pathEnv: string): string {
  return pathEnv
    .split(":")
    .filter((dir) => isAbsolute(dir))
    .join(":");
}

/**
 * The whole environment git runs with; nothing is inherited (no `GIT_DIR`, `GIT_CONFIG_*`,
 * `GIT_TRACE*`, `GIT_SSH*` or `HOME` from the daemon). System and global config are off;
 * `GIT_ALLOW_PROTOCOL` set but empty allows no transport at all, overriding any
 * `protocol.<name>.allow` in the repository; `GIT_NO_LAZY_FETCH` stops promisor fetches;
 * `GIT_OPTIONAL_LOCKS=0` keeps git from writing the index.
 */
export function gitEnv(pathEnv: string): Record<string, string> {
  return {
    PATH: absolutePath(pathEnv),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

/** The absolute path of `git` on the absolute entries of `pathEnv`, or null. */
export function findGit(pathEnv: string = process.env.PATH ?? ""): string | null {
  return Bun.which("git", { PATH: absolutePath(pathEnv) });
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
      return { text, truncated: true };
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated: false };
}

const NOT_RUN: GitOutput = Object.freeze({ code: -1, stdout: "", truncated: false });

/** Resolves null when `signal` aborts: a killed git's grandchild may hold stdout open. */
function abortOf(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

/**
 * The real runner: `Bun.spawn([gitPath, ...GIT_GUARD_ARGS, ...args])` with {@link gitEnv},
 * stdin and stderr closed, stdout read up to `maxBytes` (then the process is killed), and
 * SIGKILL when `signal` aborts.
 */
export function bunGitRunner(
  gitPath: string,
  opts: { maxBytes?: number; pathEnv?: string } = {},
): GitRunner {
  const env = gitEnv(opts.pathEnv ?? process.env.PATH ?? "");
  const maxBytes = opts.maxBytes ?? MAX_GIT_OUTPUT_BYTES;
  return async (args, cwd, signal) => {
    if (signal.aborted) return NOT_RUN;
    let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
    try {
      proc = Bun.spawn([gitPath, ...GIT_GUARD_ARGS, ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        signal,
        killSignal: "SIGKILL",
      });
    } catch {
      return NOT_RUN;
    }
    const out = await Promise.race([readBounded(proc.stdout, maxBytes), abortOf(signal)]);
    if (out === null || out.truncated) proc.kill("SIGKILL");
    if (out === null) return NOT_RUN;
    const code = await Promise.race([proc.exited, abortOf(signal)]);
    if (code === null || signal.aborted) return NOT_RUN;
    return { code, stdout: out.text, truncated: out.truncated };
  };
}
