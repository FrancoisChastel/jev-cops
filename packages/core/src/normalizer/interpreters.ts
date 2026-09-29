import { type Classification, type InterpreterInfo, plain } from "./classification.ts";
import { optionValue, parseArgs } from "./options.ts";
import type { PathArg } from "./types.ts";

/** Shells: always interpreters; `-c` code is parsed recursively as bash. */
export const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"] as const;

/** Language interpreters and the flags that take inline code (never parsed). */
export const INTERPRETER_INLINE_FLAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
};

const LANG_VALUE_OPTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  python: ["-m", "-W", "-X"],
  python2: ["-m", "-W", "-X"],
  python3: ["-m", "-W", "-X"],
  node: ["-r", "--require", "--import", "--loader"],
  perl: ["-I", "-M"],
  ruby: ["-I", "-r"],
};

const SHELL_VALUE_OPTS = new Set(["-o", "-O", "--rcfile", "--init-file"]);
const SU_VALUE_OPTS = new Set(["-c", "--command", "-s", "--shell", "-g", "-G"]);

function info(
  shell: boolean,
  code: string | null,
  stdin: boolean,
  isEval = false,
): InterpreterInfo {
  return { shell, code, stdin, eval: isEval };
}

function interpreted(name: string, interp: InterpreterInfo, script?: PathArg): Classification {
  return plain("exec", [name], { interpreter: interp, paths: script ? [script] : [] });
}

function execPath(value: string, index: number): PathArg {
  return { value, index, access: "exec" };
}

function classifyShell(name: string, args: ReadonlyArray<string>, base: number): Classification {
  const parsed = parseArgs(args, SHELL_VALUE_OPTS);
  const first = parsed.positionals[0];
  if (parsed.options.some((o) => o.name === "-c")) {
    return interpreted(name, info(true, first?.value ?? null, false));
  }
  const readsStdin = parsed.options.some((o) => o.name === "-s");
  if (first === undefined || first.value === "-" || readsStdin) {
    return interpreted(name, info(true, null, true));
  }
  return interpreted(name, info(true, null, false), execPath(first.value, base + first.index));
}

function langKey(name: string): string | null {
  if (INTERPRETER_INLINE_FLAGS[name] !== undefined) return name;
  if (/^python[0-9.]+$/.test(name)) return "python3";
  return name === "nodejs" ? "node" : null;
}

function classifyLang(
  name: string,
  key: string,
  args: ReadonlyArray<string>,
  base: number,
): Classification {
  const inline = INTERPRETER_INLINE_FLAGS[key] ?? [];
  const parsed = parseArgs(args, new Set([...inline, ...(LANG_VALUE_OPTS[key] ?? [])]));
  const code = optionValue(parsed, inline);
  if (code !== null) return interpreted(name, info(false, code, false));
  if (parsed.options.some((o) => o.name === "-m")) return plain("exec", [name]);
  const first = parsed.positionals[0];
  if (first === undefined || first.value === "-") return interpreted(name, info(false, null, true));
  return plain("exec", [name], { paths: [execPath(first.value, base + first.index)] });
}

function classifySu(args: ReadonlyArray<string>): Classification {
  const code = optionValue(parseArgs(args, SU_VALUE_OPTS), ["-c", "--command"]);
  const interp = code === null ? null : info(true, code, false);
  return plain("exec", ["su", "privilege"], { interpreter: interp });
}

/**
 * Classifies interpreters: shells (`-c` code, stdin, or a script), `eval` (its args
 * joined as code), `source`/`.` (a script), `su -c`, and python/node/perl/ruby/php
 * with inline code or stdin. A language running a script file is a plain exec with
 * the script as an exec path. Returns null when `name` is not an interpreter.
 * `base` is the argv index of `args[0]`.
 */
export function classifyInterpreter(
  name: string,
  args: ReadonlyArray<string>,
  base: number,
): Classification | null {
  if ((SHELLS as ReadonlyArray<string>).includes(name)) return classifyShell(name, args, base);
  if (name === "eval") return interpreted(name, info(true, args.join(" "), false, true));
  if (name === "source" || name === ".") {
    const script = args[0] === undefined ? undefined : execPath(args[0], base);
    return interpreted(name, info(true, null, false, true), script);
  }
  if (name === "su") return classifySu(args);
  const key = langKey(name);
  return key === null ? null : classifyLang(name, key, args, base);
}
