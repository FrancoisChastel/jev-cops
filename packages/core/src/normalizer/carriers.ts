import type { CallKind } from "../schema/event.ts";
import { readTar } from "./archives.ts";
import { type CarriedCode, type Classification, plain } from "./classification.ts";
import { RSYNC_VALUE_OPTS, SSH_VALUE_OPTS, verbHosts } from "./net.ts";
import { type ParsedArgs, type ParsedOption, parseArgs } from "./options.ts";
import { rsyncPaths } from "./writers.ts";

/**
 * Commands that carry another command in an argument (M3 of the M0 gate review): the
 * carried text is returned as {@link CarriedCode} and parsed as bash by the command
 * analysis, so its verbs and targets are judged instead of laundered through one word.
 * Parsing as bash over-approximates carriers that only split on whitespace: a `;` they
 * would pass through literally is read as a second command, which is the visible side.
 */

/**
 * A command-name word holding shell syntax or whitespace: `'rm -rf x'`, `'a; b'`,
 * `` 'a`id`' ``, `'a$(id)'`. Its basename is not a command (`env 'rm -rf /x'` would read
 * as an exec of `x`), so it is flagged `dynamic-command` instead.
 */
export const DYNAMIC_COMMAND_NAME = /[\s;|&<>`]|\$\(/;

/** True when `word`, in command-name position, must not be read through its basename. */
export function isDynamicName(word: string): boolean {
  return DYNAMIC_COMMAND_NAME.test(word);
}

/** Single-quotes `word` for bash so it is re-read as one literal word. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * `env -S <string> [args…]`: env splits the string into words and runs them followed by
 * `args`. Returned as shell code: the string verbatim, then each arg quoted.
 */
export function splitStringCode(split: string, rest: ReadonlyArray<string>): string {
  return [split, ...rest.map(shellQuote)].join(" ");
}

function local(code: string): CarriedCode {
  return { code, remote: false, opaque: true };
}

function values(parsed: ParsedArgs, names: ReadonlyArray<string>): string[] {
  return parsed.options
    .filter((o) => names.includes(o.name) && o.value !== null && o.value !== "")
    .map((o) => o.value ?? "");
}

/** GNU tar options whose value is a program tar runs (through `sh -c` or exec). */
const TAR_CODE_OPTS = [
  "--to-command",
  "--use-compress-program",
  "-I",
  "--info-script",
  "--new-volume-script",
  "-F",
  "--rsh-command",
];
const TAR_VALUE_OPTS = new Set([
  ...TAR_CODE_OPTS,
  "--checkpoint-action",
  ...["-f", "--file", "-C", "--directory", "-T", "--files-from", "-X", "--exclude-from"],
  ...["-b", "--blocking-factor", "-H", "--format", "-V", "--label", "-g"],
  ...["--listed-incremental", "-L", "--tape-length", "--exclude"],
]);
const CHECKPOINT_EXEC = /^exec=(.*)$/s;

/**
 * `tar`: the programs of `--to-command`, `--use-compress-program`/`-I`, `--info-script`
 * /`--new-volume-script`/`-F`, `--rsh-command` and `--checkpoint-action=exec=…` are
 * carried code (local, opaque). Kind and paths from {@link readTar} (what it reads and
 * writes by mode); `base` is the argv index of `args[0]`.
 */
export function classifyTar(args: ReadonlyArray<string>, base: number): Classification {
  const parsed = parseArgs(args, TAR_VALUE_OPTS);
  const checkpoints = values(parsed, ["--checkpoint-action"])
    .map((v) => CHECKPOINT_EXEC.exec(v)?.[1])
    .filter((c): c is string => c !== undefined && c !== "");
  const codes = [...values(parsed, TAR_CODE_OPTS), ...checkpoints];
  const { kind, paths } = readTar(args, base, TAR_VALUE_OPTS);
  return plain(
    kind,
    ["tar"],
    codes.length === 0 ? { paths } : { paths, carried: codes.map(local) },
  );
}

const SSH_CONFIG = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/s;

/** Values of `-o Key=value` / `-o 'Key value'` options for the ssh config keys `keys`. */
function sshConfig(options: ReadonlyArray<ParsedOption>, keys: ReadonlyArray<string>): string[] {
  return options.flatMap((o) => {
    const match = o.name === "-o" && o.value !== null ? SSH_CONFIG.exec(o.value) : null;
    const key = match?.[1]?.toLowerCase();
    const value = match?.[2]?.trim() ?? "";
    return key !== undefined && keys.includes(key) && value !== "" ? [value] : [];
  });
}

/** `ProxyCommand` and `LocalCommand` run on this host, through the user's shell. */
const LOCAL_SSH_KEYS = ["proxycommand", "localcommand"];

/**
 * `ssh [opts] host [opts] [cmd…]`: kind `net` to the host. The remote command (the words
 * after the host, joined with spaces as ssh sends them, or `-o RemoteCommand=`) is carried
 * as remote code; `-o ProxyCommand=`/`LocalCommand=` as local code. OpenSSH reads options
 * again after the host, until the first word of the command.
 */
export function classifySsh(args: ReadonlyArray<string>): Classification {
  const before = parseArgs(args, SSH_VALUE_OPTS, true);
  const host = before.positionals[0];
  const after = parseArgs(
    host === undefined ? [] : args.slice(host.index + 1),
    SSH_VALUE_OPTS,
    true,
  );
  const options = [...before.options, ...after.options];
  const words = after.positionals.map((p) => p.value);
  const remote = words.length > 0 ? [words.join(" ")] : sshConfig(options, ["remotecommand"]);
  const carried = [
    ...sshConfig(options, LOCAL_SSH_KEYS).map(local),
    ...remote.map((code) => ({ code, remote: true, opaque: true })),
  ];
  const hosts = verbHosts("ssh", args);
  return plain("net", ["ssh"], carried.length === 0 ? { hosts } : { hosts, carried });
}

/** `scp`/`sftp`: `-o ProxyCommand=`/`LocalCommand=` are local code; the rest is unchanged. */
export function sshConfigCode(args: ReadonlyArray<string>): CarriedCode[] {
  return sshConfig(parseArgs(args, SSH_VALUE_OPTS).options, LOCAL_SSH_KEYS).map(local);
}

/**
 * `rsync`: `-e`/`--rsh` is the transport command rsync runs locally, carried without an
 * `interpreter` flag of its own (a plain `ssh -p 2222` stays a plain net call; shell code
 * in it is flagged by its own parse); `--rsync-path` runs on the remote side. Local paths
 * from {@link rsyncPaths}; `base` is the argv index of `args[0]`.
 */
export function classifyRsync(args: ReadonlyArray<string>, base: number): Classification {
  const parsed = parseArgs(args, RSYNC_VALUE_OPTS);
  const carried: CarriedCode[] = [
    ...values(parsed, ["-e", "--rsh"]).map((code) => ({ code, remote: false, opaque: false })),
    ...values(parsed, ["--rsync-path"]).map((code) => ({ code, remote: true, opaque: true })),
  ];
  const hosts = verbHosts("rsync", args);
  const kind: CallKind = hosts.length > 0 ? "net" : "fs.write";
  const paths = rsyncPaths(args, base, RSYNC_VALUE_OPTS);
  return plain(
    kind,
    ["rsync"],
    carried.length === 0 ? { hosts, paths } : { hosts, paths, carried },
  );
}
