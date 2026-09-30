/**
 * Headless detection (PLAN-M1 §2 row 10, D-068 proposal). The hook input carries a
 * `permission_mode` but no interactive/print flag, so the session mode is read from the argv
 * of the `claude` process that spawned the hook: headless iff it runs in print mode (`-p`,
 * `--print`) with no permission host (`--permission-prompt-tool`, unless
 * `--permission-prompts none`). A wrong "interactive" guess only yields an `ask` that a
 * host-less `-p` run denies; but that run then shows the ask's reason to Claude (observed on
 * 2.1.280), so a parent that cannot be read, or is not recognizably `claude`, counts as
 * headless.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { SessionMode } from "@jev-cops/core";

/** A process's parent pid and argv. */
export interface ProcInfo {
  readonly ppid: number;
  readonly args: readonly string[];
}

/** Reads a process by pid; null when it cannot be read. */
export type ProcReader = (pid: number) => ProcInfo | null;

/** Shells and wrappers between Claude Code and a shell-form hook (compared lower-case, no `.exe`). */
const SHELLS: ReadonlySet<string> = new Set([
  ...["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "tcsh", "csh"],
  ...["cmd", "powershell", "pwsh", "env"],
]);
/** How many shell layers are unwrapped before giving up (and counting the session headless). */
const MAX_SHELL_LAYERS = 3;
/** An npm install runs `node …/@anthropic-ai/claude-code/cli.js`. */
const CLAUDE_PACKAGE = /[\\/]claude-code[\\/]/i;
/** A cluster of short flags (`-cp`) that includes `p`. */
const SHORT_CLUSTER = /^-[A-Za-z]*p[A-Za-z]*$/;
const PS_TIMEOUT_MS = 1_000;

function isPrint(flag: string): boolean {
  return flag === "--print" || SHORT_CLUSTER.test(flag);
}

function hasHost(flags: readonly string[]): boolean {
  const tool = flags.some(
    (f) => f === "--permission-prompt-tool" || f.startsWith("--permission-prompt-tool="),
  );
  const none = flags.some(
    (f, i) =>
      f === "--permission-prompts=none" ||
      (f === "--permission-prompts" && flags[i + 1] === "none"),
  );
  return tool && !none;
}

/** The session mode a `claude` argv implies (argv[0] is the executable). */
export function modeOfArgs(args: readonly string[]): SessionMode {
  const flags = args.slice(1);
  return flags.some(isPrint) && !hasHost(flags) ? "headless" : "interactive";
}

/** An executable's base name: lower-case, no login-shell `-`, no extension, Windows paths too. */
function exeName(path: string | undefined): string {
  return basename((path ?? "").replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/^-/, "")
    .replace(/\.(exe|cmd|[cm]?[jt]s)$/, "");
}

/** True when an argv is Claude Code's: `claude …`, or an interpreter running Claude Code. */
export function isClaude(args: readonly string[]): boolean {
  return args.slice(0, 2).some((a) => exeName(a) === "claude" || CLAUDE_PACKAGE.test(a));
}

/**
 * The mode of the session whose `claude` spawned this hook. `ppid` is the hook's parent:
 * claude itself in exec form; in shell form up to {@link MAX_SHELL_LAYERS} shells are
 * unwrapped. Anything that cannot be read, or that is not recognizably Claude Code, counts
 * as headless: a hold is then denied, never asked (an ask a host-less run cannot show a
 * human would show its reason, with the daemon's detail, to Claude).
 */
export function detectMode(ppid: number, read: ProcReader): SessionMode {
  let pid = ppid;
  for (let layer = 0; layer <= MAX_SHELL_LAYERS; layer += 1) {
    const proc = read(pid);
    if (proc === null) return "headless";
    if (isClaude(proc.args)) return modeOfArgs(proc.args);
    if (!SHELLS.has(exeName(proc.args[0]))) return "headless";
    pid = proc.ppid;
  }
  return "headless";
}

/** One line of `ps -o ppid= -o args=`: the ppid, then the argv split on whitespace. */
export function parsePsLine(line: string): ProcInfo | null {
  const m = /^\s*(\d+)\s+(\S.*)$/s.exec(line);
  if (m === null) return null;
  return { ppid: Number(m[1]), args: (m[2] ?? "").trim().split(/\s+/) };
}

/** The ppid field of `/proc/<pid>/stat` (after the parenthesized command name). */
export function parseProcStat(stat: string): number | null {
  const m = /\)\s+\S+\s+(\d+)/.exec(stat.slice(stat.lastIndexOf(")")));
  return m === null ? null : Number(m[1]);
}

/** `/proc/<pid>/cmdline`: NUL-separated arguments. */
export function parseProcCmdline(cmdline: string): string[] {
  return cmdline.split("\0").filter((a, i, all) => !(a === "" && i === all.length - 1));
}

function readLinux(pid: number): ProcInfo | null {
  try {
    const ppid = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    const args = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    return ppid === null ? null : { ppid, args };
  } catch {
    return null; // the process is gone or unreadable: the caller treats it as headless
  }
}

function readPs(pid: number, ps: string): ProcInfo | null {
  try {
    const res = Bun.spawnSync([ps, "-o", "ppid=", "-o", "args=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: PS_TIMEOUT_MS,
    });
    return res.exitCode === 0 ? parsePsLine(res.stdout.toString()) : null;
  } catch {
    return null; // no `ps` to run: the caller treats the session as headless
  }
}

/** Reads a process: `/proc` on Linux, `ps` elsewhere (macOS); `ps` names the binary to run. */
export function readProc(pid: number, ps = "ps"): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return process.platform === "linux" ? readLinux(pid) : readPs(pid, ps);
}
