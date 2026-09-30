/**
 * Remote skill sources (PLAN-SETUP §4.1, S-8): the scanner never fetches; the daemon calls
 * this to clone an https git source into a private temp dir, then materializes that copy.
 * Hardened like D-067's git runner: exec form, an absolute git, an environment built from
 * scratch (no system or global config, no credential helper, no prompt, https as the only
 * transport, no lazy fetch, no LFS smudge), every config hook off, `--depth 1`, no
 * submodules, no redirects, 20 s, 100 MiB on disk, the commit recorded. `ssh://`, `git@`,
 * credentials in the URL, private hosts and zip downloads are refused without running
 * anything; every refusal or failure is `remote source not fetched: <why>` (the gate holds).
 */
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "@jev-cops/core";
import { exitError, outcomeError, processEnv, REMOTE_NOT_FETCHED } from "./adapters/shared.ts";
import { type RunOutcome, runBounded, type Spawn, scanEnv } from "./run.ts";
import type { Env } from "./types.ts";

/** Budget of one clone (and, separately, of the `rev-parse` that pins it). */
export const REMOTE_DEADLINE_MS = 20_000;
/** Largest clone kept on disk. */
export const REMOTE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Flags before every git subcommand: no pager, no fsmonitor, no hooks, no credential helper,
 * every transport off but https, no redirects (a public URL cannot bounce to a private
 * host), objects checked, submodules never followed.
 */
export const GIT_CLONE_GUARD: readonly string[] = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
  "-c",
  "transfer.fsckObjects=true",
  "-c",
  "submodule.recurse=false",
]);

/** Proxy settings pass through (a corporate network needs them); nothing else does. */
const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * True for a host a skill source must not be fetched from: loopback, private, link-local
 * and reserved IPv4 ranges, every IPv6 literal (not classified, refused), single-label
 * names and local suffixes. Best effort: a public name that resolves to a private address
 * is not caught here.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || h.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4 !== null) return privateV4(Number(v4[1]), Number(v4[2]));
  if (!h.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((s) => h.endsWith(s));
}

/** Why `url` is not fetched, or null for an https URL to a public host. */
export function remoteUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not an https URL";
  }
  if (u.protocol !== "https:") return `only https sources are fetched (${u.protocol})`;
  if (u.username !== "" || u.password !== "") return "credentials in the URL are refused";
  if (isPrivateHost(u.hostname)) return `private host refused: ${u.hostname}`;
  if (u.pathname.toLowerCase().endsWith(".zip")) return "zip downloads are not supported yet";
  return null;
}

/** What the fetch needs; `git` is the daemon's absolute git (e.g. `findGit()`). */
export interface RemoteDeps {
  readonly git: string;
  readonly spawn?: Spawn;
  /** The daemon's environment (for `PATH` and proxies only). */
  readonly env?: Env;
  readonly deadlineMs?: number;
  readonly maxBytes?: number;
}

/** A clone on disk, pinned to its commit. */
export interface FetchedSource {
  /** The working tree (with its `.git`, which materializing skips). */
  readonly dir: string;
  readonly commit: string;
  readonly bytes: number;
  /** Removes the clone and its temp directory. */
  cleanup(): Promise<void>;
}

function gitEnv(source: Env, home: string): Record<string, string> {
  return {
    ...scanEnv(source, PROXY_ENV),
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

/** Bytes under `dir` (symlinks counted, never followed); stops counting past `cap`. */
async function diskUsage(dir: string, cap: number): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0 && total <= cap) {
    const current = pending.pop() ?? dir;
    for (const e of await readdir(current, { withFileTypes: true })) {
      const path = join(current, e.name);
      if (e.isDirectory()) pending.push(path);
      else total += (await lstat(path)).size;
    }
  }
  return total;
}

function cloneError(o: RunOutcome): string {
  if (o.kind !== "exit") return `git clone: ${outcomeError("git", o)}`;
  return exitError("git clone", o.code, o.stderrTail);
}

async function cloneInto(
  href: string,
  tmp: string,
  deps: RemoteDeps,
): Promise<Result<{ dir: string; commit: string; bytes: number }, string>> {
  const dest = join(tmp, "src");
  const spawn = deps.spawn ?? runBounded;
  const env = gitEnv(deps.env ?? processEnv(), tmp);
  const deadlineMs = deps.deadlineMs ?? REMOTE_DEADLINE_MS;
  const run = (args: readonly string[]) =>
    spawn({ argv: [deps.git, ...GIT_CLONE_GUARD, ...args], cwd: tmp, env, deadlineMs });
  const flags = ["--depth", "1", "--no-tags", "--single-branch", "--no-recurse-submodules"];
  const clone = await run(["clone", ...flags, "--", href, dest]);
  if (clone.kind !== "exit" || clone.code !== 0) return err(cloneError(clone));
  const cap = deps.maxBytes ?? REMOTE_MAX_BYTES;
  const bytes = await diskUsage(dest, cap);
  if (bytes > cap) return err(`over ${cap} bytes`);
  const head = await run(["-C", dest, "rev-parse", "HEAD"]);
  const commit = head.kind === "exit" && head.code === 0 ? head.stdout.trim() : "";
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return err("no commit to pin");
  return ok({ dir: dest, commit, bytes });
}

/**
 * Clones the https git source `url` into a fresh `<root>/remote.<random>/src`, pinned to
 * its commit. Nothing runs for a refused URL; a failed or oversized clone is removed.
 */
export async function fetchGitSource(
  url: string,
  root: string,
  deps: RemoteDeps,
): Promise<Result<FetchedSource, string>> {
  const fail = (why: string) => err(`${REMOTE_NOT_FETCHED}: ${why}`);
  const problem = remoteUrlProblem(url);
  if (problem !== null) return fail(problem);
  if (!isAbsolute(deps.git)) return fail("git must be an absolute path");
  let tmp: string;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    tmp = await mkdtemp(join(root, "remote."));
  } catch (cause) {
    return fail(`cannot create the fetch directory: ${(cause as Error).message}`);
  }
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  const cloned = await cloneInto(new URL(url).href, tmp, deps).catch((cause: unknown) =>
    err(`cannot read the clone: ${(cause as Error).message}`),
  );
  if (!cloned.ok) {
    await cleanup();
    return fail(cloned.error);
  }
  return ok({ ...cloned.value, cleanup });
}
