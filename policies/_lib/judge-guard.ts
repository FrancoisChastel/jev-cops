import type { PolicyEvent } from "@jev-cops/sdk";
import type { Finding } from "./config-findings.ts";
import { canon } from "./config-trees.ts";
import { programsOf } from "./program.ts";

/**
 * The judge guarding itself (M1 gate review, findings M2 and L1; D-099, D-100), as
 * `config-tamper` findings, all held: a non-write access to one of the judge's private
 * records (`ctx.config.privatePaths`: audit log, store, `~/.jev-cops/`, the scored
 * decisions agent channels never carry, T6); the agent running `cops explain|replay`
 * (which print them), `cops install` or `cops budget --reset` (`cops` as the program, not
 * as a word: `echo cops explain` is not); stopping `copsd` or `cops-hook` by name
 * (`pkill`/`killall` patterns, `kill $(pgrep …)`, a `launchctl`/`systemctl` stop), each
 * tool matched only as the command's program past wrappers (`echo pkill -f copsd` is
 * not). A bare pid, or the judge running under another name, is not recognized (a
 * printed gap).
 */

type Command = PolicyEvent["commands"][number];

/** The judge's CLI and processes, and what stops a process or service by name. */
const JUDGE_CLI = "cops";
const JUDGE = ["copsd", "cops-hook"];
const KILL = ["kill"];
const BY_NAME = ["pkill", "killall"];
const LOOKUPS = ["pgrep", "pidof"];
const SERVICE_STOPS: Readonly<Record<string, readonly string[]>> = {
  launchctl: ["stop", "kill", "unload", "bootout", "remove", "disable"],
  systemctl: ["stop", "kill", "disable", "mask"],
};

function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** argv from its first word named in `names` (past `sudo`, `xargs`, …), or null. */
function from(argv: readonly string[], names: readonly string[]): readonly string[] | null {
  const at = argv.findIndex((a) => names.includes(baseName(a)));
  return at < 0 ? null : argv.slice(at);
}

/**
 * argv from the program the command runs when that program is one of `names` (past
 * wrappers, or run by `find -exec`), else null: `sudo pkill …` runs `pkill`, `echo pkill …`
 * runs `echo`.
 */
function running(c: Command, names: readonly string[]): readonly string[] | null {
  const program = programsOf(c).find((p) => names.includes(p));
  return program === undefined ? null : from(c.argv, [program]);
}

/** A pkill/pgrep pattern or killall name that would select the judge (bad regex: as text). */
function selectsJudge(pattern: string): boolean {
  const re = (() => {
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  })();
  return JUDGE.some((j) => pattern.includes(j) || re?.test(j) === true || re?.test(`/${j}`));
}

function operands(argv: readonly string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith("-"));
}

function stopsByName(c: Command): boolean {
  const signal = running(c, BY_NAME);
  if (signal !== null) return operands(signal).some(selectsJudge);
  const service = running(c, Object.keys(SERVICE_STOPS)) ?? [];
  const stops = SERVICE_STOPS[baseName(service[0] ?? "")] ?? [];
  const names = (w: string) => JUDGE.some((j) => w.includes(j));
  return service.some((w) => stops.includes(w)) && service.some(names);
}

/**
 * Stopping `copsd` or `cops-hook` by name: DoS only, the hook fails closed without copsd.
 * A `pkill`/`killall` or service stop naming the judge, or, when the call also runs `kill`
 * (`kill $(pgrep …)`, `pgrep … | xargs kill`), a `pgrep`/`pidof` selecting it.
 */
export function stopFindings(e: PolicyEvent): Finding[] {
  const kills = e.commands.some((c) => running(c, KILL) !== null);
  const looked = (c: Command) => {
    const lookup = kills ? running(c, LOOKUPS) : null;
    return lookup !== null && operands(lookup).some(selectsJudge);
  };
  return e.commands
    .filter((c) => stopsByName(c) || looked(c))
    .map((c) => ({ tier: "hold", target: c.argv.join(" "), how: "stop" }));
}

/** `privatePaths`: the longest entry a path is equal to or under decides; `!` exempts. */
function isPrivate(path: string, privatePaths: readonly string[]): boolean {
  const p = canon(path);
  const best = privatePaths
    .map((raw) => ({ exempt: raw.startsWith("!"), root: canon(raw.replace(/^!/, "")) }))
    .filter((x) => p === x.root || p.startsWith(`${x.root}/`))
    .toSorted((a, b) => b.root.length - a.root.length || Number(a.exempt) - Number(b.exempt))[0];
  return best !== undefined && !best.exempt;
}

/** The judge's records read, run or touched unknowably (writes and deletes are tree findings). */
export function privateReadFindings(e: PolicyEvent, privatePaths: readonly string[]): Finding[] {
  return Object.entries(e.fs.access)
    .filter(([path, how]) => how !== "write" && how !== "delete" && isPrivate(path, privatePaths))
    .map(([path]): Finding => ({ tier: "hold", target: path, how: "private" }));
}

/**
 * The agent running the judge's CLI to print its record or change its configuration: a
 * command that runs `cops` as a program (past `sudo`, `env`, `command`, …, or through
 * `find -exec`; inside `bash -c` too, whose string the normalizer parses into commands of
 * its own). A `cops` word elsewhere (`echo cops explain`, `grep cops`) is not. `copsd` and
 * `cops-hook` take no subcommands.
 */
export function judgeCliFindings(e: PolicyEvent): Finding[] {
  return e.commands.flatMap((c): Finding[] => {
    if (!programsOf(c).includes(JUDGE_CLI)) return [];
    const words = from(c.argv, [JUDGE_CLI]) ?? [];
    const sub = operands(words)[0] ?? "";
    const target = `cops ${sub}`;
    if (sub === "explain" || sub === "replay") return [{ tier: "hold", target, how: "private" }];
    const changes = sub === "install" || (sub === "budget" && words.includes("--reset"));
    return changes ? [{ tier: "hold", target, how: "cli" }] : [];
  });
}
