import type { CallKind } from "../schema/event.ts";
import { scpHost } from "./net.ts";
import { hasOption, lookup, type ParsedArgs, parseArgs } from "./options.ts";
import type { PathAccess, PathArg } from "./types.ts";

/** git subcommand → kind; subcommands not listed are `exec`. */
export const GIT_SUBCOMMAND_KINDS: Readonly<Record<string, CallKind>> = {
  show: "fs.read",
  diff: "fs.read",
  log: "fs.read",
  status: "fs.read",
  blame: "fs.read",
  add: "fs.write",
  commit: "fs.write",
  checkout: "fs.write",
  switch: "fs.write",
  stash: "fs.write",
  apply: "fs.write",
  clean: "fs.delete",
  rm: "fs.delete",
  push: "net",
  fetch: "net",
  pull: "net",
  clone: "net",
};

const GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const SUB_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  commit: new Set(["-m", "--message", "-F", "--file", "-C", "-c", "--author", "--date"]),
  clean: new Set(["-e", "--exclude"]),
  checkout: new Set(["-b", "-B", "--orphan"]),
  push: new Set(["-o", "--push-option", "--repo"]),
  clone: new Set(["-b", "--branch", "--depth", "-o", "--origin", "--reference"]),
};
const PATH_SUBCOMMANDS: Readonly<Record<string, PathAccess>> = {
  add: "write",
  rm: "delete",
};
const NET_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone"]);
const SHELL_CONFIG_KEYS = new Set(
  ["core.sshcommand", "core.pager", "core.editor", "core.fsmonitor", "core.askpass"].concat([
    "core.gitproxy",
    "sequence.editor",
    "credential.helper",
    "diff.external",
    "gpg.program",
  ]),
);
const SHELL_CONFIG_PATTERN =
  /^pager\.|\.(?:command|cmd|textconv|driver|process|clean|smudge|helper|program|tool)$/;

/** The shell code a `-c key=value` makes git run: `!` aliases and command-valued keys. */
function configCode(setting: string): string | null {
  const eq = setting.indexOf("=");
  if (eq < 0) return null;
  const key = setting.slice(0, eq).toLowerCase();
  const value = setting.slice(eq + 1);
  if (key.startsWith("alias.")) return value.startsWith("!") ? value.slice(1) : null;
  return SHELL_CONFIG_KEYS.has(key) || SHELL_CONFIG_PATTERN.test(key) ? value : null;
}
const FORCE = ["force", "irreversible"];

function forcedPush(parsed: ParsedArgs): boolean {
  const force = hasOption(parsed, ["--force", "-f", "--force-with-lease", "--mirror"]);
  return force || parsed.positionals.some((p) => p.value.startsWith("+"));
}

function discardsChanges(parsed: ParsedArgs, args: ReadonlyArray<string>): boolean {
  const afterDashDash = args.includes("--") && parsed.positionals.length > 0;
  return afterDashDash || parsed.positionals.some((p) => p.value === ".");
}

function forcedBranchDelete(parsed: ParsedArgs): boolean {
  if (hasOption(parsed, ["-D"])) return true;
  return hasOption(parsed, ["-d", "--delete"]) && hasOption(parsed, ["-f", "--force"]);
}

function irreversibleVerbs(sub: string, parsed: ParsedArgs, args: ReadonlyArray<string>): string[] {
  switch (sub) {
    case "push":
      return forcedPush(parsed) ? FORCE : [];
    case "reset":
      return hasOption(parsed, ["--hard"]) ? ["hard", "irreversible"] : [];
    case "checkout":
      return discardsChanges(parsed, args) ? ["irreversible"] : [];
    case "clean":
      return hasOption(parsed, ["-f", "--force"]) ? FORCE : [];
    case "branch":
      return forcedBranchDelete(parsed) ? FORCE : [];
    case "rebase":
      return ["irreversible"];
    default:
      return [];
  }
}

/** What a git invocation does: kind, verbs (with force/hard/irreversible), paths, hosts. */
export interface GitReading {
  kind: CallKind;
  verbs: string[];
  paths: PathArg[];
  hosts: string[];
  /** Shell code smuggled in through `-c` config (aliases, pagers, ssh commands, …). */
  code: string | null;
}

/**
 * Classifies `git <args>`; `base` is the argv index of `args[0]`. Global options
 * (`-C dir`, `-c k=v`, …) are skipped to find the subcommand. Irreversible forms
 * (force push, `reset --hard`, `checkout -- .`, `clean -f`, `branch -D`, `rebase`)
 * add verbs; they never change the kind. Shell code in `-c` config is returned as `code`.
 */
export function readGit(args: ReadonlyArray<string>, base: number): GitReading {
  const global = parseArgs(args, GLOBAL_VALUE_OPTS, true);
  const first = global.positionals[0];
  const code =
    global.options
      .filter((o) => o.name === "-c" && o.value !== null)
      .map((o) => configCode(o.value ?? ""))
      .find((c) => c !== null) ?? null;
  if (first === undefined) return { kind: "exec", verbs: ["git"], paths: [], hosts: [], code };
  const sub = first.value;
  const subArgs = args.slice(first.index + 1);
  const subBase = base + first.index + 1;
  const parsed = parseArgs(subArgs, lookup(SUB_VALUE_OPTS, sub) ?? new Set());
  const access = lookup(PATH_SUBCOMMANDS, sub);
  const paths =
    access === undefined
      ? []
      : parsed.positionals.map((p) => ({ value: p.value, index: subBase + p.index, access }));
  const hosts = NET_SUBCOMMANDS.has(sub)
    ? parsed.positionals.map((p) => scpHost(p.value)).filter((h): h is string => h !== null)
    : [];
  return {
    kind: lookup(GIT_SUBCOMMAND_KINDS, sub) ?? "exec",
    verbs: ["git", sub, ...irreversibleVerbs(sub, parsed, subArgs)],
    paths,
    hosts,
    code,
  };
}
