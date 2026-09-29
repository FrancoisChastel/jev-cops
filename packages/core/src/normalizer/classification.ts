import type { CallKind } from "../schema/event.ts";
import type { NetMethod, PathArg } from "./types.ts";

/** How an interpreter gets its code: inline (`code`), from stdin, or from a script file. */
export interface InterpreterInfo {
  shell: boolean;
  code: string | null;
  stdin: boolean;
  eval: boolean;
}

/**
 * A command carried in an argument and run by the carrier: parsed as bash like `sh -c`
 * code. `remote`: it runs on another host (ssh's remote command). `opaque`: the carrier
 * is flagged `interpreter` for it (false for rsync's `-e`, whose transport command is
 * judged on what it parses to).
 */
export interface CarriedCode {
  code: string;
  remote: boolean;
  opaque: boolean;
}

/** Everything the classifier derives from one argv, before paths are resolved. */
export interface Classification {
  kind: CallKind;
  verbs: string[];
  /** Set when the effective command is an interpreter, `eval`, `source` or `su -c`. */
  interpreter: InterpreterInfo | null;
  /** An opaque wrapper (env, sudo, xargs, find -exec, …) was unwrapped. */
  wrapped: boolean;
  env: Record<string, string>;
  method?: NetMethod;
  paths: PathArg[];
  hosts: string[];
  /** Commands carried in arguments (env -S, tar programs, ssh remote commands, …). */
  carried?: CarriedCode[];
  /** The command name holds shell syntax or whitespace (`dynamic-command`). */
  dynamic?: boolean;
}

/**
 * Command kinds from least to most severe, used to combine the parts of one command
 * (a verb, its redirects, its wrapper) and the commands of one event.
 */
export const COMMAND_KIND_ORDER: ReadonlyArray<CallKind> = [
  "other",
  "fs.read",
  "exec",
  "spawn",
  "fs.write",
  "net",
  "fs.delete",
];

/** The more severe of two kinds by {@link COMMAND_KIND_ORDER}. */
export function maxKind(a: CallKind, b: CallKind): CallKind {
  return COMMAND_KIND_ORDER.indexOf(a) >= COMMAND_KIND_ORDER.indexOf(b) ? a : b;
}

/** A classification with no interpreter, wrapper, env, paths or hosts unless given. */
export function plain(
  kind: CallKind,
  verbs: string[],
  rest: Partial<Classification> = {},
): Classification {
  return {
    kind,
    verbs,
    interpreter: null,
    wrapped: false,
    env: {},
    paths: [],
    hosts: [],
    ...rest,
  };
}
