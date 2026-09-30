import type { PolicyEvent } from "@jev-cops/sdk";

/**
 * The program a normalized command runs. The normalizer unwraps wrappers and puts each
 * wrapper's verbs before the wrapped command's (`sudo cops budget` → `["sudo", "privilege",
 * "cops"]`), and every command's own verbs start with the basename of its name; so the
 * program is the first verb past the wrappers'. `find … -exec` is read the same way: its
 * verbs are `find`'s, then the exec'd command's. A word elsewhere in argv is not a program:
 * `echo cops explain` runs `echo`, `git commit -m "cops budget"` runs `git`.
 */

type Command = PolicyEvent["commands"][number];

/** Verbs the normalizer's wrappers add (core `WRAPPERS`; `program.test.ts` keeps them equal). */
export const WRAPPER_VERBS: ReadonlySet<string> = new Set([
  "env",
  "nohup",
  "setsid",
  "sudo",
  "doas",
  "privilege",
  "timeout",
  "xargs",
  "nice",
  "time",
  "command",
  "builtin",
  "exec",
  "stdbuf",
]);

/** `find`'s own verbs, before those of the command its `-exec` runs. */
const FIND_VERBS: ReadonlySet<string> = new Set(["find", "delete"]);

function firstProgram(verbs: readonly string[]): string | null {
  return verbs.find((v) => !WRAPPER_VERBS.has(v)) ?? null;
}

/** The command's program past any wrapper (`sudo`, `env`, `xargs`, …); null when unknown. */
export function programOf(c: Command): string | null {
  return firstProgram(c.verbs);
}

/** Every program the command runs: its own, then the one a `find … -exec` runs. */
export function programsOf(c: Command): string[] {
  const own = programOf(c);
  if (own !== "find") return own === null ? [] : [own];
  const exec = firstProgram(c.verbs.slice(c.verbs.indexOf(own)).filter((v) => !FIND_VERBS.has(v)));
  return exec === null ? [own] : [own, exec];
}
